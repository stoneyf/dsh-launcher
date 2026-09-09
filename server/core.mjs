/**
 * DSH 本地启动器 V3 后端 — 核心模块
 * 路径常量、launcher.env 读写、settings.yaml 片段同步、通用工具。
 * 零第三方依赖，仅使用 Node 内置模块。
 * V3 新增：DSH_LAUNCHER_ROOT 环境变量可覆盖根目录（测试用）；
 * 端口占用者查询（netstat）与等待端口释放，服务重启编排依赖。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import net from 'node:net'

export const LAUNCHER_VERSION = '3.3.0'

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

export const CONFIG_DEFAULTS = {
  LAUNCHER_PORT: '7610',
  DSH_HOST: '127.0.0.1',
  DSH_PORT: '3080',
  OPEN_BROWSER: '1',
  LLM_HOST: '127.0.0.1',
  LLM_PORT: '8080',
  LLM_MODEL: 'models\\Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf',
  LLM_CTX: '32768',
  LLM_NGPU: '999',
  LLM_PARALLEL: '1',
  LLM_API_KEY: 'local',
  HUB_ALLOWLIST_ONLY: '0',
  HUB_MIRROR: 'https://hf-mirror.com',
  THEME: 'dark',
  LAUNCHER_UPDATE_URL: '',
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

/** 把本地大模型接入 Harness：维护 llm-deepseek 与 agent-default-model 两段。 */
export function syncSettings() {
  const cfg = readConfig()
  const id = modelId()
  const llmPort = Number(cfg.LLM_PORT)
  const ctx = Number(cfg.LLM_CTX) || 32768
  const llmSection = [
    'llm-deepseek:',
    '  apiKeyEnv: LLM_API_KEY',
    `  baseURL: 'http://${cfg.LLM_HOST}:${llmPort}/v1'`,
    '  thinking: disabled',
    '  maxTokens: 8192',
    `  defaultContextWindow: ${ctx}`,
    '  models:',
    `    - id: ${id}`,
    `      name: ${id}`,
    `      contextWindow: ${ctx}`,
    '      maxTokens: 8192',
  ].join('\r\n')
  const selSection = [
    'agent-default-model:',
    '  provider: deepseek-official',
    `  model: ${id}`,
  ].join('\r\n')
  let content = existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, 'utf8') : ''
  content = replaceYamlSection(content, 'llm-deepseek', llmSection)
  content = replaceYamlSection(content, 'agent-default-model', selSection)
  mkdirSync(DIRS.data, { recursive: true })
  writeFileSync(SETTINGS_FILE, content, 'utf8')
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
