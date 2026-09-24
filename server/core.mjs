/**
 * DSH 本地启动器 V3 后端 — 核心模块
 * 路径常量、launcher.env 读写、settings.yaml 片段同步、通用工具。
 * 零第三方依赖，仅使用 Node 内置模块。
 * V3 新增：DSH_LAUNCHER_ROOT 环境变量可覆盖根目录（测试用）；
 * 端口占用者查询（netstat）与等待端口释放，服务重启编排依赖。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'

export const LAUNCHER_VERSION = '4.2.2'

const serverDir = dirname(fileURLToPath(import.meta.url))
/** 根目录：默认取 server 上一级；DSH_LAUNCHER_ROOT 可覆盖（与传给 dsh 进程的同名变量一致，便于测试与外部发现）。 */
export const ROOT = resolve(process.env.DSH_LAUNCHER_ROOT || join(serverDir, '..'))

export const DIRS = {
  root: ROOT,
  config: join(ROOT, 'config'),
  data: join(ROOT, 'data'),
  logs: join(ROOT, 'logs'),
  models: join(ROOT, 'models'),
  harness: join(ROOT, 'harness'),
  llm: join(ROOT, 'llm'),
  runtimeNode: join(ROOT, 'runtime', 'node'),
  gui: join(ROOT, 'gui'),
  tarballs: join(ROOT, 'vendor', 'tarballs'),
  npmCache: join(ROOT, 'npm-cache'),
}

export const CONFIG_FILE = join(DIRS.config, 'launcher.env')
export const SETTINGS_FILE = join(DIRS.data, 'settings.yaml')

/** js-yaml：复用 harness 自带的那份（与 dsh 解析 profile patch 用同一个库，避免行为差异）。
 *  启动器本体保持零第三方依赖——不装包，借 harness 的 node_modules。 */
const yaml = (() => {
  for (const anchor of [join(DIRS.harness, 'node_modules'), join(ROOT, 'node_modules')]) {
    try {
      return createRequire(join(anchor, 'noop.js'))('js-yaml')
    } catch { /* 换下一个锚点 */ }
  }
  return null
})()

export const CONFIG_DEFAULTS = {
  LAUNCHER_PORT: '7610',
  DSH_HOST: '127.0.0.1',
  DSH_PORT: '3080',
  OPEN_BROWSER: '1',
  LLM_HOST: '127.0.0.1',
  LLM_PORT: '8080',
  LLM_MODEL: 'models\\Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf',
  LLM_MMPROJ: '',
  LLM_CTX: 'auto',
  LLM_MAXTOKENS: 'auto',
  LLM_NGPU: '999',
  LLM_PARALLEL: '1',
  // 追加给 llama-server 的额外命令行参数（空格分隔）。默认关掉思考链：
  // 本机模型是推理模型，chat template 默认保留 reasoning，每轮回复都带
  // reasoning_content 字段；DSH 端 llm-deepseek 按 thinking: disabled 构造
  // 请求，两边对不上会报 "Messages expected a JSON object"。
  LLM_EXTRA_ARGS: '--reasoning off',
  LLM_API_KEY: 'local',
  HUB_ALLOWLIST_ONLY: '0',
  HUB_MIRROR: 'https://hf-mirror.com',
  THEME: 'dark',
  AUTO_START: '0',
  AUTO_START_SERVICES: '0',
  LAUNCHER_UPDATE_URL: '',
  DOWNLOAD_PROXY: '',
  DIRECT_HOSTS: '',
}

// ---------- 开机自启（仅登录后） ----------
// 4.1.9：**去掉免登录**。此前用「计划任务（ONSTART + SYSTEM）+ HKCU Run」双机制，
// 让开机时无人登录也能跑服务；但它引入了两个实例（SYSTEM 会话 0 + 登录会话 1）并存的
// 架构问题：① 开机时 SYSTEM 实例正忙于加载 15GB 本地模型，登录实例附着探测容易超时
// → 退化成随机端口 → 出现「端口已占用」提示；② 服务归属混乱（llama 是 SYSTEM 实例的
// 子进程，登录实例的 llm.pid 却是空的）→ 界面上点「停止全部」停不掉；③ SYSTEM 实例在
// Session 0 无界面，用户看不见它在管什么。
// 现在只保留 HKCU Run 登录项：用户登录后拉起启动器（托盘/窗口）+（若勾选
// 「开机自动启动服务」）本地模型与 Harness。开机到登录之间不跑任何东西；
// 「免登录也能用」改由用户自己的远程控制方案解决。
// 注意：setAutoStart 仍会**主动清理**历史遗留的计划任务，避免旧版本创建的任务
// 在升级后继续把 SYSTEM 实例拉起来。
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'DSH Launcher'
const LEGACY_TASK_NAME = 'DSH Launcher Autostart'

/** 删除历史遗留的免登录计划任务（4.1.8 及更早版本创建）。 */
function removeLegacyAutoStartTask() {
  try {
    spawnSync('schtasks', ['/Delete', '/F', '/TN', LEGACY_TASK_NAME], { windowsHide: true })
  } catch { /* 任务不存在或 schtasks 不可用 */ }
}

/** 写入/删除「开机自启」：只写 HKCU Run（登录后拉起），并清理历史遗留的计划任务。 */
export function setAutoStart(enabled) {
  const exe = join(ROOT, 'dsh-launcher.exe')
  const target = existsSync(exe) ? exe : join(ROOT, 'launcher.bat')
  // 无论开启还是关闭，都清掉旧版留下的免登录计划任务
  removeLegacyAutoStartTask()
  const data = `"${target}"${enabled ? ' --silent' : ''}`
  if (enabled) {
    spawnSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', data, '/f'], { windowsHide: true })
  } else {
    spawnSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true })
  }
  return { enabled: Boolean(enabled), target }
}

/** 读取当前自启状态（只看 HKCU Run；历史遗留计划任务会被顺手清理）。 */
export function isAutoStart() {
  removeLegacyAutoStartTask()
  try {
    const r = spawnSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { windowsHide: true, encoding: 'utf8' })
    if (r.status === 0 && /DSH Launcher/i.test(r.stdout ?? '')) return true
    if (r.status === 0) return false
  } catch { /* reg 不可用 */ }
  return readConfig().AUTO_START === '1'
}

export function ensureDirs() {
  for (const dir of [DIRS.config, DIRS.data, DIRS.logs, DIRS.models, DIRS.npmCache]) {
    mkdirSync(dir, { recursive: true })
  }
}

/** 读取 launcher.env，返回全部键值（缺失项用默认值）。 */
export function readConfig() {
  const cfg = { ...CONFIG_DEFAULTS }
  if (existsSync(CONFIG_FILE)) {
    for (const raw of readFileSync(CONFIG_FILE, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
      const i = line.indexOf('=')
      if (i <= 0) continue
      cfg[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  return cfg
}

/** 合并写入 launcher.env（保留注释行，按键更新，新键追加）。 */
export function writeConfig(updates) {
  mkdirSync(DIRS.config, { recursive: true })
  const lines = existsSync(CONFIG_FILE)
    ? readFileSync(CONFIG_FILE, 'utf8').split(/\r?\n/)
    : []
  const merged = { ...readConfig(), ...updates }
  const written = new Set()
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('#') && !t.startsWith(';')) {
      const i = t.indexOf('=')
      if (i > 0) {
        const key = t.slice(0, i).trim()
        if (Object.prototype.hasOwnProperty.call(merged, key)) {
          out.push(`${key}=${merged[key]}`)
          written.add(key)
          continue
        }
      }
    }
    out.push(line)
  }
  for (const [key, value] of Object.entries(merged)) {
    if (!written.has(key)) out.push(`${key}=${value}`)
  }
  writeFileSync(CONFIG_FILE, out.join('\r\n') + '\r\n', 'utf8')
}

export function modelPath() {
  const p = readConfig().LLM_MODEL
  return p.includes(':\\') || p.startsWith('\\\\') ? p : join(ROOT, p)
}

export function modelId() {
  return modelPath().split(/[\\/]/).pop().replace(/\.gguf$/i, '')
}

/** 视觉投影器（mmproj）路径；LLM_MMPROJ 为空表示不启用视觉，返回 null。 */
export function mmprojPath() {
  const p = readConfig().LLM_MMPROJ
  if (!p || !String(p).trim()) return null
  const v = String(p).trim()
  return v.includes(':\\') || v.startsWith('\\\\') ? v : join(ROOT, v)
}

export function llmBaseUrl() {
  const c = readConfig()
  return `http://${c.LLM_HOST}:${Number(c.LLM_PORT)}`
}

/** 替换 settings.yaml 顶层段（保留其他内容），与 V1 PowerShell 行为一致。 */
export function replaceYamlSection(content, sectionName, replacement) {
  const lines = content === '' ? [] : content.split(/\r?\n/)
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!/^\s/.test(line) && !line.startsWith('#') && line.trimStart().startsWith(`${sectionName}:`)) {
      i++
      while (i < lines.length && (/^\s/.test(lines[i]) || lines[i].trim() === '')) i++
      continue
    }
    out.push(line)
    i++
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  out.push(replacement)
  out.push('')
  return out.join('\r\n')
}

/** 探测模型 gguf：原生上下文 + 每 token KV 缓存字节数。按模型路径缓存；python/gguf 缺失返回 null。 */
let _probeCache = null  // { path, result }
export function probeModel() {
  const model = modelPath()
  if (_probeCache && _probeCache.path === model) return _probeCache.result
  const py = join(serverDir, 'probe_model.py')
  if (existsSync(py) && existsSync(model)) {
    try {
      const r = run('python', [py, model])
      if (r.ok) {
        const line = String(r.stdout).trim().split('\n').pop()
        if (line && line.startsWith('{')) _probeCache = { path: model, result: JSON.parse(line) }
      }
    } catch { /* 兜底：走固定上下文 */ }
  }
  return _probeCache ? _probeCache.result : null
}

/** GPU 总显存（MiB）；nvidia-smi 缺失/失败返回 0。 */
export function getTotalVramMiB() {
  try {
    const r = run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'])
    const n = Number(String(r.stdout).trim().split(/\s+/)[0])
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch { return 0 }
}

/** 解析上下文窗口：LLM_CTX=auto 时按显存自动计算（取能容纳的最大 16K 整数倍），否则用固定值。 */
export function resolveCtx() {
  const cfg = readConfig()
  const raw = String(cfg.LLM_CTX ?? '').trim().toLowerCase()
  if (raw !== 'auto') return Number(cfg.LLM_CTX) || 32768
  const probe = probeModel()
  const totalVram = getTotalVramMiB()
  const model = modelPath()
  const modelBytes = existsSync(model) ? statSync(model).size : 0
  if (!probe?.kv_per_token || !totalVram || !modelBytes) return 131072  // 兜底：探测不到用 128K
  const overheadMiB = 1536   // CUDA 上下文 + embedding + 杂项开销
  const safetyMiB = 1024     // 额外预留余量
  const modelVramMiB = modelBytes / 1048576 + overheadMiB
  const kvBudgetMiB = totalVram - modelVramMiB - safetyMiB
  if (kvBudgetMiB <= 0) return 8192
  let ctx = Math.floor(kvBudgetMiB * 1048576 / probe.kv_per_token)
  if (probe.native_context) ctx = Math.min(ctx, probe.native_context)  // 不超过模型原生上限
  ctx = Math.floor(ctx / 16384) * 16384   // 向下取整到 16K 整数倍
  ctx = Math.max(ctx, 8192)               // 下限保护
  return ctx
}

/** 解析最大输出 token：LLM_MAXTOKENS=auto 时用模型自身上限（探测，缺省 32K），否则用固定值；最终都不超过上下文窗口。 */
export function resolveMaxTokens(ctx) {
  const cfg = readConfig()
  const raw = String(cfg.LLM_MAXTOKENS ?? '').trim().toLowerCase()
  const modelMax = probeModel()?.max_output ?? 32768
  const cap = raw === 'auto' ? modelMax : (Number(cfg.LLM_MAXTOKENS) || modelMax)
  return Math.min(cap, ctx)
}

/** 把本地大模型接入 Harness：在 profile patch 的 llm-pi-ai 路由里维护 local-llama 这条 OpenAI 协议 config，
 *  并把 agent-default-model 指向它（4.2.2 起本地模型改走 openai-completions 适配器，不再用 llm-deepseek 私有协议）。
 *
 *  0.1.7 起 harness 废弃了 `data\settings.yaml`：启动时 dsh-settings 会把该文件改名成
 *  `settings.yaml.imported` 并把各段迁进 profile 的 patch（= `cordis.patch.yml`），
 *  之后所有配置读写都走 configEditor.documentPath → patchPath。启动器若还往老路径写，
 *  会被 dsh 下次启动再次迁走，形成「写了就没、找不到就 ENOENT」的循环，
 *  dsh-tasks / ml-study 的模型自动切换因此失效（停不掉、也切不回）。
 */
/** 读取 profile patch 里指定 id 的条目（不存在返回 null）。解析失败也返回 null，不抛。 */
export function readProfileEntry(id) {
  const file = profilePatchFile()
  if (yaml === null || !existsSync(file)) return null
  let doc
  try {
    doc = yaml.load(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(doc)) return null
  let target = null
  for (const row of doc) {
    if (row && typeof row === 'object' && row.id === id) target = row
  }
  return target
}

export function syncSettings() {
  const cfg = readConfig()
  const id = modelId()
  const llmPort = Number(cfg.LLM_PORT)
  const ctx = resolveCtx()
  const maxTok = resolveMaxTokens(ctx)
  // 配置了视觉投影器（LLM_MMPROJ）时声明图像输入能力，DSH 才会放行图片内容。
  const vision = mmprojPath() !== null
  // llama-server 说的是标准 OpenAI 协议，必须挂在 openai-completions 适配器下。
  // 4.2.2 之前本地模型误配在 llm-deepseek（DeepSeek 私有 Messages 协议）上，
  // 简单回复碰巧能过、但工具调用参数解析一碰就报 "DeepSeek Messages expected a JSON object"。
  // 现改走 llm-pi-ai 路由下的 local-llama（openai-completions），云端 deepseek 路由不动。
  const localLlama = {
    api: 'openai-completions',
    baseURL: `http://${cfg.LLM_HOST}:${llmPort}/v1`,
    apiKeyEnv: 'LLM_API_KEY',
    models: [
      {
        id,
        contextWindow: ctx,
        maxTokens: maxTok,
        ...(vision ? { inputModalities: ['text', 'image'] } : {}),
      },
    ],
  }
  // 只更新 local-llama 这一个 provider，云端 deepseek（DEEPSEEK_API_KEY）保持不动。
  // patchProfileEntries 是整段覆盖语义，所以先把现有 providers 读出来再合回去。
  const piConfig = { providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } }
  const existing = readProfileEntry('llm-pi-ai')
  if (existing?.config?.providers && typeof existing.config.providers === 'object') {
    piConfig.providers = { ...existing.config.providers, 'local-llama': localLlama }
  }
  const selConfig = { provider: 'local-llama', model: id }
  patchProfileEntries([
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: piConfig },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: selConfig },
  ])
}

/** profile patch 文件（cordis.patch.yml）：0.1.7 起 Harness 配置的唯一落盘位置。 */
export function profilePatchFile() {
  return join(DIRS.data, 'profiles', 'web', 'cordis.patch.yml')
}

/** 合并式写入 profile patch：按 id 更新/追加条目并保留其余内容与注释。
 *  用 js-yaml 解析（与 dsh 同款），写回前整份校验，避免写坏 dsh 起不来。
 *  @param {Array<{id: string, name?: string, config: object}>} entries 要同步的条目 */
export function patchProfileEntries(entries) {
  const file = profilePatchFile()
  if (yaml === null) {
    console.warn('[launcher] 取不到 js-yaml（harness 未安装？），跳过配置同步')
    return { ok: false, reason: 'no-yaml' }
  }
  if (!existsSync(file)) {
    // profile 尚未生成：写成裸 settings.yaml 也没用（dsh 会迁走），直接跳过并留下线索。
    console.warn(`[launcher] profile patch 不存在，跳过配置同步：${file}`)
    return { ok: false, reason: 'patch-missing' }
  }
  let doc
  try {
    doc = yaml.load(readFileSync(file, 'utf8'))
  } catch (error) {
    console.warn(`[launcher] profile patch 解析失败，跳过配置同步：${error.message}`)
    return { ok: false, reason: 'parse-failed' }
  }
  if (!Array.isArray(doc)) {
    console.warn('[launcher] profile patch 不是顶层数组，跳过配置同步')
    return { ok: false, reason: 'not-a-list' }
  }
  for (const entry of entries) {
    // 同 id 可能有多条（历史遗留），Last-wins 语义：只改最后一条，其余原样保留。
    let target = null
    for (const row of doc) {
      if (row && typeof row === 'object' && row.id === entry.id) target = row
    }
    if (target === null) {
      doc.push({ id: entry.id, ...(entry.name ? { name: entry.name } : {}), config: entry.config })
    } else {
      target.config = entry.config
      if (entry.name && target.name === undefined) target.name = entry.name
    }
  }
  const text = yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' })
  // 自校验：dump 出来的东西必须还能解析回等价结构，否则宁可不写。
  const round = yaml.load(text)
  if (!Array.isArray(round) || round.length !== doc.length) {
    console.warn('[launcher] profile patch 自校验失败，未写入')
    return { ok: false, reason: 'verify-failed' }
  }
  writeFileSync(file, text, 'utf8')
  return { ok: true, count: entries.length }
}


/** 运行外部命令（同步），返回 {ok, stdout, stderr, code}。 */
export function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...options })
  return { ok: r.status === 0, code: r.status ?? r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export function nodeExe() {
  const bundled = join(DIRS.runtimeNode, 'node.exe')
  return existsSync(bundled) ? bundled : 'node'
}

export function npmCli() {
  const bundled = join(DIRS.runtimeNode, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(bundled) ? bundled : null
}

export function pidFile(name) {
  return join(DIRS.logs, `${name}.pid`)
}

export function readPid(name) {
  try {
    const v = readFileSync(pidFile(name), 'utf8').trim()
    return /^\d+$/.test(v) ? Number(v) : null
  } catch { return null }
}

export function writePid(name, pid) {
  mkdirSync(DIRS.logs, { recursive: true })
  writeFileSync(pidFile(name), String(pid), 'ascii')
}

export function clearPid(name) {
  try { writeFileSync(pidFile(name), '', 'ascii') } catch { /* ignore */ }
}

export function logPath(name) {
  return join(DIRS.logs, name)
}

/** 读日志尾部 N 行。 */
export function logTail(name, lines = 50) {
  try {
    const content = readFileSync(logPath(name), 'utf8')
    return content.split(/\r?\n/).slice(-lines).join('\n')
  } catch { return '' }
}

export function isWindows() {
  return process.platform === 'win32'
}

export const TASKKILL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')

/** 结束进程树：先 graceful kill，超时后 taskkill /T /F。 */
export async function killProcessTree(pid) {
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ }
  await new Promise(resolve => setTimeout(resolve, 3000))
  try {
    process.kill(pid, 0)
  } catch {
    return // 已退出
  }
  run(TASKKILL, ['/PID', String(pid), '/T', '/F'])
}

/** TCP 端口是否被占用（任意进程）。 */
export function tcpPortBusy(host, port) {
  return new Promise(resolvePort => {
    const socket = net.connect({ host, port, timeout: 600 })
    socket.once('connect', () => { socket.destroy(); resolvePort(true) })
    socket.once('timeout', () => { socket.destroy(); resolvePort(false) })
    socket.once('error', () => resolvePort(false))
  })
}

/** 下一个空闲端口（从 start 起顺延）。 */
export async function freePortAfter(host, start) {
  let port = start
  while (await tcpPortBusy(host, port)) port++
  return port
}

/** 延时。 */
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/** 查询监听指定端口的进程 PID 列表（netstat -ano）。
 *  用于识别「pid 文件已失效但仍占着端口」的孤儿进程（如 agent 自启动的 dsh）。 */
export function portHolderPids(port) {
  const r = run('netstat', ['-ano', '-p', 'TCP'])
  if (!r.ok) return []
  const suffix = `:${port} `
  const pids = new Set()
  for (const line of r.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    // 格式: Proto LocalAddr ForeignAddr State PID
    if (parts.length < 5) continue
    if (parts[3] !== 'LISTENING') continue
    if (!parts[1].endsWith(suffix) && !parts[1].endsWith(`:${port}`)) continue
    if (/^\d+$/.test(parts[4]) && parts[4] !== '0') pids.add(Number(parts[4]))
  }
  return [...pids]
}

/** 等待端口释放；超时返回 false。每轮间隔 intervalMs。 */
export async function waitPortFree(port, timeoutMs = 20000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (portHolderPids(port).length === 0) return true
    await sleep(intervalMs)
  }
  return portHolderPids(port).length === 0
}

/** 列表目录下的 *-backup-* 目录名。 */
export function backupDirs(baseDir) {
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /-backup-/.test(e.name))
      .map(e => e.name)
      .sort()
  } catch { return [] }
}
