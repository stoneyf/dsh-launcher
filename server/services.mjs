/**
 * 进程管理：llama-server 与 dsh 的启动/停止/重启/状态。
 * 与 V1 PowerShell 脚本共享 pid 文件、日志文件与数据格式。
 *
 * V3 新增「重启编排」：stop → 端口占用者查杀 → 等待端口释放 → start → 就绪。
 * 重启由启动器进程独立完成（API 立即 202 返回），调用方即使是被重启进程的
 * 子孙（如 dsh 会话内的 agent 自己发起重启）也能完成整个流程。
 * 进度通过 serviceEvents（EventEmitter）广播，供 SSE 与 /api/status 查询。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  DIRS, ROOT, readConfig, writePid, readPid, clearPid, logPath, logTail,
  nodeExe, llmBaseUrl, modelPath, modelId, mmprojPath, syncSettings, killProcessTree,
  tcpPortBusy, freePortAfter, sleep, portHolderPids, waitPortFree, resolveCtx,
} from './core.mjs'

const state = { llm: null, dsh: null }

const POLL_MS = 3000

/** 服务事件总线：{ service, type, phase?, detail?, ts }。type: restart | state。 */
export const serviceEvents = new EventEmitter()
serviceEvents.setMaxListeners(200)

/** 最近 64 条事件环形缓冲：新 SSE 订阅者先回放历史，避免连接晚于首发事件时漏掉 stopping 等早期阶段。 */
export const serviceEventHistory = []

/** 进行中的重启任务：{ phase, detail, startedAt }；未重启为 null。 */
const restarting = { llm: null, dsh: null }

function emitService(evt) {
  const full = { ts: Date.now(), ...evt }
  serviceEventHistory.push(full)
  if (serviceEventHistory.length > 64) serviceEventHistory.shift()
  serviceEvents.emit('service', full)
  try { console.log(`[launcher] ${evt.service ?? '?'} ${evt.type ?? ''}${evt.phase ? `:${evt.phase}` : ''}${evt.detail ? ` ${evt.detail}` : ''}`.trim()) } catch { /* 断管 */ }
}

/** 自愈：内存 state 声称在跑但 pid 已死（例如 agent 绕过启动器杀过进程）→ 清掉，避免「已在运行」误报。 */
function selfHeal(name) {
  const st = state[name]
  if (st?.running) {
    const pid = st.proc?.pid ?? readPid(name)
    if (!pidAlive(pid)) {
      state[name] = null
      emitService({ service: name, type: 'state', detail: 'stale-state-cleared' })
    }
  }
}

/** 查杀端口占用者（孤儿进程）。返回被杀的 pid 数。 */
async function killPortHolders(port, excludePid = null) {
  const holders = portHolderPids(port).filter(p => p !== excludePid && p !== process.pid)
  for (const pid of holders) {
    try { await killProcessTree(pid) } catch { /* 忽略 */ }
  }
  return holders.length
}

async function httpStatus(url, timeoutMs = 4000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.status
  } catch { return null }
}

function openLog(name) {
  return createWriteStream(logPath(name), { flags: 'a' })
}

/** 等待 LLM 就绪：/v1/models 返回 200。 */
async function waitLlmReady(timeoutSec = 900) {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    if ((await httpStatus(`${llmBaseUrl()}/v1/models`)) === 200) return
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  throw new Error(`等待本地大模型就绪超时（${timeoutSec}s）：` + logTail('llm.err.log', 10))
}

/** 等待 dsh 就绪：任意 HTTP 响应（含 401）即视为服务已监听。 */
async function waitDshReady(host, port, timeoutSec = 90) {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    const code = await httpStatus(`http://${host}:${port}/`)
    if (code !== null) return
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`等待 Harness 就绪超时（${timeoutSec}s）：` + logTail('dsh.err.log', 15))
}

/** 从 dsh 输出日志解析带 token 的访问地址。
 *  只读取本次启动之后写入的日志部分（按文件偏移），避免取到历史启动的旧 token。 */
async function resolveTokenUrl(plainUrl, logStartOffset) {
  for (let i = 0; i < 20; i++) {
    try {
      const { statSync, openSync, readSync, closeSync } = await import('node:fs')
      const size = statSync(logPath('dsh.out.log')).size
      if (size > logStartOffset) {
        const fd = openSync(logPath('dsh.out.log'), 'r')
        const len = size - logStartOffset
        const buf = Buffer.alloc(len)
        readSync(fd, buf, 0, len, logStartOffset)
        closeSync(fd)
        const matches = [...buf.toString('utf8').matchAll(/dsh web: (http\S+)/g)]
        if (matches.length > 0) return matches[matches.length - 1][1]
      }
    } catch { /* 文件尚未出现 */ }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return plainUrl
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export async function llmStatus() {
  const cfg = readConfig()
  const pid = readPid('llm')
  const health = (await httpStatus(`${llmBaseUrl()}/v1/models`, 1500)) === 200
  let running = state.llm?.running === true || pidAlive(pid)
  // 启动器之外启动的本地模型（如 dsh-tasks 插件的 Auto 本地切换）：pid 文件为空
  // 但端口健康检查通过 → 同样视为运行中，避免状态页误报「未启动」而实际可用。
  if (!running && health) running = true
  const holder = running ? (pid ?? portHolderPids(Number(cfg.LLM_PORT))[0] ?? null) : null
  return {
    running,
    pid: holder,
    host: cfg.LLM_HOST,
    port: Number(cfg.LLM_PORT),
    model: modelId(),
    modelFile: modelPath(),
    mmproj: mmprojPath(),
    endpoint: `${llmBaseUrl()}/v1`,
    health,
  }
}

export function dshStatus() {
  const cfg = readConfig()
  const pid = readPid('dsh')
  const running = state.dsh?.running === true || pidAlive(pid)
  let url = null
  try {
    url = state.dsh?.url ?? readFileSync(join(DIRS.logs, 'dsh.url'), 'utf8').trim() ?? null
  } catch { /* 无记录 */ }
  return { running, pid: running ? pid : null, host: cfg.DSH_HOST, port: Number(cfg.DSH_PORT), url }
}

export function anyServiceRunning() {
  return state.llm?.running === true || state.dsh?.running === true
}

export async function startLlm() {
  selfHeal('llm')
  if (state.llm?.running) throw new Error('本地大模型已在运行。')
  const cfg = readConfig()
  const exe = join(DIRS.llm, 'llama-server.exe')
  if (!existsSync(exe)) throw new Error(`llama-server.exe 不存在（${exe}）。请先运行 setup.bat。`)
  const model = modelPath()
  if (!existsSync(model)) throw new Error(`模型文件不存在（${model}）。请在启动器模型管理中下载。`)
  const mmproj = mmprojPath()
  if (mmproj && !existsSync(mmproj)) throw new Error(`视觉投影器文件不存在（${mmproj}）。请先下载 mmproj 文件，或清空 LLM_MMPROJ。`)
  if (await tcpPortBusy(cfg.LLM_HOST, Number(cfg.LLM_PORT))) {
    // 端口被「同一个」本地模型占着（如 dsh-tasks 插件 Auto 本地切换启动的实例）：
    // 提示用「重启本地模型」，而不是误导用户去改端口号。
    if ((await httpStatus(`${llmBaseUrl()}/v1/models`, 1500)) === 200) {
      throw new Error(`本地大模型已在运行（端口 ${cfg.LLM_PORT} 健康检查通过，可能是插件 Auto 本地切换启动的）。想换配置请用「重启本地模型」。`)
    }
    throw new Error(`端口 ${cfg.LLM_PORT} 已被占用。请修改 config\\launcher.env 的 LLM_PORT。`)
  }
  syncSettings()
  const args = [
    '-m', model,
    '--alias', modelId(),
    '--host', cfg.LLM_HOST,
    '--port', String(cfg.LLM_PORT),
    '--ctx-size', String(resolveCtx()),
    '--n-gpu-layers', String(cfg.LLM_NGPU),
    '--parallel', String(cfg.LLM_PARALLEL),
    '--jinja',
  ]
  // 视觉：加载 mmproj 投影器后，llama-server 支持图像/视频输入（OpenAI image_url）
  if (mmproj) args.push('--mmproj', mmproj)
  const proc = spawn(exe, args, {
    cwd: DIRS.llm,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc.stdout.pipe(openLog('llm.out.log'))
  proc.stderr.pipe(openLog('llm.err.log'))
  proc.on('exit', () => {
    state.llm = null
    clearPid('llm')
  })
  state.llm = { running: true, proc }
  writePid('llm', proc.pid)
  try {
    await waitLlmReady(900)
  } catch (error) {
    await stopLlm()
    throw error
  }
  return llmStatus()
}

export async function stopLlm() {
  selfHeal('llm')
  const cfg = readConfig()
  const pid = readPid('llm')
  if (pid) await killProcessTree(pid)
  // 清掉绕过启动器启动、pid 文件失效但仍占着端口的孤儿进程
  await killPortHolders(Number(cfg.LLM_PORT), pid).catch(() => 0)
  state.llm = null
  clearPid('llm')
}

/**
 * 让 profile 的 webserver 端口跟随启动器实际使用的端口。
 *
 * web profile 的 cordis.patch.yml 里有一行 webserver 配置（remote-web-ui 的
 * lan-bind 块，带「do not edit」标记），它在 patch 层覆盖 `dsh web --port`。
 * 不同步的话：改 config\launcher.env 的 DSH_PORT 不生效，端口回退也会让 dsh
 * 撞回原端口（EADDRINUSE）而不是换到新端口。只改 webserver 那一行，别的不动。
 *
 * @returns 变更说明，或 null（无需变更 / 找不到该配置）
 */
export function syncWebserverPort(port) {
  try {
    const file = join(DIRS.data, 'profiles', 'web', 'cordis.patch.yml')
    if (!existsSync(file)) return null
    const lines = readFileSync(file, 'utf8').split('\n')
    const start = lines.findIndex(line => line.includes('@deepseek-ai/dsh-host-webserver'))
    if (start < 0) return null
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      if (/^- /.test(lines[i])) { end = i; break }
    }
    for (let i = start; i < end; i++) {
      const match = /^(\s*port:\s*)(\d+)\s*$/.exec(lines[i])
      if (!match) continue
      if (Number(match[2]) === port) return null
      const previous = Number(match[2])
      lines[i] = `${match[1]}${port}`
      const temp = `${file}.port-sync-${process.pid}`
      writeFileSync(temp, lines.join('\n'))
      renameSync(temp, file)
      return `webserver 端口 ${previous} → ${port}`
    }
    return null
  } catch (error) {
    // 同步失败不该挡住启动：dsh 的 --port 仍会尝试生效，失败原因以日志为准
    return `端口同步失败（${error.message}）`
  }
}

export async function startDsh({ openBrowser = true, allowPortFallback = true } = {}) {
  selfHeal('dsh')
  if (state.dsh?.running) throw new Error('Harness 已在运行。')
  const cfg = readConfig()
  const bin = join(DIRS.harness, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) throw new Error(`Harness 未安装（${bin}）。请先运行 setup.bat。`)
  syncSettings()
  let port = Number(cfg.DSH_PORT)
  const host = cfg.DSH_HOST
  if (await tcpPortBusy(host, port)) {
    if (allowPortFallback) {
      port = await freePortAfter(host, port)
    } else {
      throw new Error(`端口 ${port} 已被占用。`)
    }
  }
  const portSync = syncWebserverPort(port)
  if (portSync) console.log(`[launcher] ${portSync}`)
  const args = [bin, 'web', '--host', host, '--port', String(port)]
  if (!openBrowser || cfg.OPEN_BROWSER !== '1') args.push('--no-open')
  const env = {
    ...process.env,
    DSH_LAUNCHER_ROOT: ROOT,
    DSH_HOME: DIRS.data,
    DSH_AGENTS_HOME: join(DIRS.data, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    LLM_API_KEY: cfg.LLM_API_KEY,
    NPM_CONFIG_CACHE: DIRS.npmCache,
    PNPM_HOME: join(ROOT, 'vendor', 'pnpm-home'),
    COREPACK_HOME: join(ROOT, 'vendor', 'corepack-home'),
    PATH: `${DIRS.runtimeNode};${process.env.PATH ?? ''}`,
  }
  // 记录启动前的日志偏移：token 只从本次启动写入的日志中解析
  let logStartOffset = 0
  try {
    const { statSync } = await import('node:fs')
    logStartOffset = statSync(logPath('dsh.out.log')).size
  } catch { /* 日志尚不存在 */ }
  const proc = spawn(nodeExe(), args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc.stdout.pipe(openLog('dsh.out.log'))
  proc.stderr.pipe(openLog('dsh.err.log'))
  proc.on('exit', () => {
    state.dsh = null
    clearPid('dsh')
  })
  state.dsh = { running: true, proc, port }
  writePid('dsh', proc.pid)
  try {
    await waitDshReady(host, port, 90)
  } catch (error) {
    await stopDsh()
    throw error
  }
  const url = await resolveTokenUrl(`http://${host}:${port}/`, logStartOffset)
  // dsh 可能「先监听、随后崩溃退出」（exit 事件已把 state.dsh 置空）：
  // 此时要报出真实原因，而不是让 state.dsh.url 赋值抛出 TypeError。
  if (!state.dsh) {
    throw new Error(`Harness 启动后立即退出（端口 ${port} 已释放）。日志尾部：` + logTail('dsh.err.log', 15))
  }
  state.dsh.url = url
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(DIRS.logs, 'dsh.url'), url, 'ascii')
  return dshStatus()
}

export async function stopDsh() {
  selfHeal('dsh')
  const cfg = readConfig()
  const pid = readPid('dsh')
  if (pid) await killProcessTree(pid)
  // 清掉绕过启动器启动、pid 文件失效但仍占着端口的孤儿进程
  await killPortHolders(Number(cfg.DSH_PORT), pid).catch(() => 0)
  state.dsh = null
  clearPid('dsh')
}

// ---------- V3：重启编排 ----------
// 停止（pid 文件 + 端口占用者查杀）→ 等待端口释放 → 启动 → 就绪。
// 全程由启动器进程独立完成；调用方（GUI、或 dsh 会话内的 agent 自己）
// 收到 202 后即可返回，自己的进程树被杀掉也不影响流程完成。

const RESTART_PHASES = ['stopping', 'killing-port-holder', 'waiting-port', 'starting', 'loading']

function setPhase(name, phase, detail) {
  const prev = restarting[name] ?? {}
  restarting[name] = { phase, detail: detail ?? '', startedAt: prev.startedAt ?? Date.now() }
  emitService({ service: name, type: 'restart', phase, detail: restarting[name].detail })
}

function clearPhaseLater(name, ms) {
  const snap = restarting[name]
  // 引用比对：若期间又开始了新一轮重启，旧定时器不清掉新状态
  setTimeout(() => { if (restarting[name] === snap) restarting[name] = null }, ms)
}

export function restartStates() {
  return { llm: restarting.llm, dsh: restarting.dsh }
}

export function restartInProgress(name) {
  return RESTART_PHASES.includes(restarting[name]?.phase)
}

async function restartService(name, { port, killFirst, start }) {
  setPhase(name, 'stopping', `正在停止……`)
  const pid = readPid(name)
  if (pid) await killFirst(pid)
  else emitService({ service: name, type: 'restart', phase: 'stopping', detail: '无 pid 文件，跳过' })
  if (await tcpPortBusy('127.0.0.1', port)) {
    setPhase(name, 'killing-port-holder', `查杀端口 ${port} 上的孤儿进程……`)
    const n = await killPortHolders(port, pid)
    emitService({ service: name, type: 'restart', phase: 'killing-port-holder', detail: `已查杀 ${n} 个占用进程` })
  }
  setPhase(name, 'waiting-port', `等待端口 ${port} 释放……`)
  if (!(await waitPortFree(port, 20000))) {
    throw new Error(`重启后端口 ${port} 仍被占用（taskkill 可能失败），请检查任务管理器。`)
  }
  setPhase(name, name === 'llm' ? 'loading' : 'starting', name === 'llm' ? '正在加载模型（可能需要一两分钟）……' : '正在启动……')
  const result = await start()
  setPhase(name, 'ready', name === 'dsh' ? (result.url ?? '') : '模型已加载')
  clearPhaseLater(name, name === 'dsh' ? 15000 : 30000)
  return result
}

export async function restartDsh({ openBrowser } = {}) {
  const cfg = readConfig()
  if (restartInProgress('dsh')) throw Object.assign(new Error('Harness 正在重启中，请稍候。'), { status: 409 })
  try {
    return await restartService('dsh', {
      port: Number(cfg.DSH_PORT),
      killFirst: pid => killProcessTree(pid),
      start: () => startDsh({
        openBrowser: openBrowser ?? cfg.OPEN_BROWSER === '1',
        allowPortFallback: false,
      }),
    })
  } catch (error) {
    setPhase('dsh', 'error', error.message)
    clearPhaseLater('dsh', 120000)
    throw error
  }
}

export async function restartLlm() {
  const cfg = readConfig()
  if (restartInProgress('llm')) throw Object.assign(new Error('本地大模型正在重启中，请稍候。'), { status: 409 })
  try {
    return await restartService('llm', {
      port: Number(cfg.LLM_PORT),
      killFirst: pid => killProcessTree(pid),
      start: () => startLlm(),
    })
  } catch (error) {
    setPhase('llm', 'error', error.message)
    clearPhaseLater('llm', 120000)
    throw error
  }
}

export async function startAll() {
  const results = {}
  results.llm = await startLlm().catch(error => ({ error: error.message }))
  results.dsh = await startDsh().catch(error => ({ error: error.message }))
  return results
}

export async function stopAll() {
  await stopDsh()
  await stopLlm()
}
