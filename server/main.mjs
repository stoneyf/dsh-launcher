/**
 * 启动器后端入口：HTTP 服务 + 路由 + token 认证 + SSE + 静态资源 + 生命周期。
 * 可被 electron 主进程 import（startServer），也可独立运行：
 *   node server\main.mjs [--browser] [--port 7610]
 *
 * 3.x 特性：
 *  - POST /api/services/{llm,dsh}/restart —— 由启动器独立完成的重启编排，
 *    立即 202 返回（调用方可以是正在被重启的 dsh 会话里的 agent）；
 *  - GET  /api/services/events —— 重启阶段进度 SSE；
 *  - /api/status 携带 versions.launcher 与 restarting 状态；
 *  - 令牌文件 logs\launcher.token（每次启动重新生成）。
 */
import http from 'node:http'
import crypto from 'node:crypto'
import {
  existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync,
  mkdirSync, readdirSync, unlinkSync, copyFileSync, statfsSync,
} from 'node:fs'
import { extname, join, basename, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  DIRS, ROOT, readConfig, writeConfig, ensureDirs, logPath, modelPath, syncSettings, tcpPortBusy,
  waitPortFree, LAUNCHER_VERSION, resolveCtx, resolveMaxTokens, probeModel,
} from './core.mjs'
import * as services from './services.mjs'
import * as gpu from './gpu.mjs'
import * as hub from './hub.mjs'
import * as chat from './chat.mjs'
import * as downloads from './downloads.mjs'
import * as versions from './versions.mjs'
import * as launcherUpdate from './launcher-update.mjs'

const TOKEN_FILE = join(DIRS.logs, 'launcher.token')
const token = crypto.randomBytes(24).toString('hex')

// GUI 宿主（Electron）的 stdout 可能已断管：吞掉 EPIPE，避免 console.log 抛异常。
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message })
}

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('retry: 2000\n\n')
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000)
  res.on('close', () => clearInterval(keepAlive))
  return {
    send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) },
    close() { clearInterval(keepAlive); res.end() },
  }
}

function authorized(req, url) {
  if (req.headers.authorization === `Bearer ${token}`) return true
  return new URL(url, 'http://127.0.0.1').searchParams.get('token') === token
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let data = ''
    req.on('data', chunk => {
      data += chunk
      if (data.length > 1024 * 1024) { req.destroy(); rejectBody(new Error('请求体过大')) }
    })
    req.on('end', () => {
      if (data === '') return resolveBody({})
      try { resolveBody(JSON.parse(data)) } catch { rejectBody(new Error('JSON 解析失败')) }
    })
    req.on('error', rejectBody)
  })
}

// ---------- 模型 API ----------

function listModels() {
  const active = basename(modelPath()).toLowerCase()
  let items = []
  try {
    items = readdirSync(DIRS.models)
      .filter(n => /\.gguf$/i.test(n))
      .map(name => {
        let size = 0
        try { size = statSync(join(DIRS.models, name)).size } catch { /* 忽略 */ }
        return { name, size, active: name.toLowerCase() === active }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch { /* 目录不存在 */ }
  return items
}

function switchModel(name) {
  const model = listModels().find(m => m.name === name)
  if (!model) throw new Error(`模型不存在：${name}`)
  writeConfig({ LLM_MODEL: `models\\${name}` })
  syncSettings()
  return { name, active: true }
}

function deleteModel(name) {
  const model = listModels().find(m => m.name === name)
  if (!model) throw new Error(`模型不存在：${name}`)
  if (model.active) throw new Error('不能删除当前正在使用的模型，请先切换。')
  unlinkSync(join(DIRS.models, name))
  return { name, deleted: true }
}

// ---------- 日志流 ----------

function streamLog(res, name) {
  const stream = sse(res)
  const path = logPath(name)
  let size = 0
  try { size = statSync(path).size } catch { /* 尚未创建 */ }
  if (size > 0) {
    try {
      const fd = openSync(path, 'r')
      const len = Math.min(size, 8192)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      closeSync(fd)
      stream.send('history', buf.toString('utf8'))
    } catch { /* 忽略 */ }
  }
  const timer = setInterval(() => {
    try {
      const st = statSync(path)
      if (st.size > size) {
        const fd = openSync(path, 'r')
        const len = st.size - size
        const buf = Buffer.alloc(len)
        readSync(fd, buf, 0, len, size)
        closeSync(fd)
        size = st.size
        stream.send('log', buf.toString('utf8'))
      }
    } catch { /* 文件被删/未出现 */ }
  }, 800)
  res.on('close', () => clearInterval(timer))
}

// ---------- 路由 ----------

const routes = []

function route(method, pattern, handler) {
  routes.push({ method, pattern, handler })
}

route('GET', /^\/api\/ping$/, (req, res) => sendJson(res, 200, { ok: true }))

route('GET', /^\/api\/status$/, async (req, res) => {
  const cfg = readConfig()
  let disk = null
  try {
    const s = statfsSync(ROOT)
    disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  } catch { /* 不可用 */ }
  // 解析后的上下文 / 最大输出（供设置页"自动"时提示实际值）
  const ctx = resolveCtx()
  const probe = probeModel()
  const llmResolved = {
    ctx,
    maxTokens: resolveMaxTokens(ctx),
    modelMaxOutput: probe?.max_output ?? 32768,
    modelNativeContext: probe?.native_context ?? null,
  }
  sendJson(res, 200, {
    services: { llm: await services.llmStatus(), dsh: services.dshStatus() },
    restarting: services.restartStates(),
    gpu: await gpu.gpuInfo(),
    config: cfg,
    llm: llmResolved,
    models: listModels(),
    versions: { launcher: LAUNCHER_VERSION, ...versions.versionSummary() },
    ports: {
      llm: await tcpPortBusy(cfg.LLM_HOST, Number(cfg.LLM_PORT)),
      dsh: await tcpPortBusy(cfg.DSH_HOST, Number(cfg.DSH_PORT)),
    },
    disk,
  })
})

route('GET', /^\/api\/gpu$/, async (req, res) => sendJson(res, 200, await gpu.gpuInfo(true)))

route('POST', /^\/api\/start-all$/, async (req, res) => sendJson(res, 200, await services.startAll()))
route('POST', /^\/api\/stop-all$/, async (req, res) => { await services.stopAll(); sendJson(res, 200, { ok: true }) })

route('POST', /^\/api\/services\/(llm|dsh)\/start$/, async (req, res, m) => {
  try {
    const result = m[1] === 'llm' ? await services.startLlm() : await services.startDsh()
    sendJson(res, 200, result)
  } catch (error) { sendError(res, 500, error.message) }
})

route('POST', /^\/api\/services\/(llm|dsh)\/stop$/, async (req, res, m) => {
  await (m[1] === 'llm' ? services.stopLlm() : services.stopDsh())
  sendJson(res, 200, { ok: true })
})

// V3：重启编排 —— 立即 202 返回，进度走 /api/services/events 与 /api/status。
// 关键：调用方可能是正在被重启的 dsh 会话内的 agent，其进程树会在
// stopping 阶段被一起杀掉，所以不能等响应体。
route('POST', /^\/api\/services\/(llm|dsh)\/restart$/, (req, res, m) => {
  const svc = m[1]
  if (services.restartInProgress(svc)) return sendError(res, 409, `${svc === 'dsh' ? 'Harness' : '本地大模型'} 正在重启中，请稍候。`)
  sendJson(res, 202, { started: true, service: svc })
  void (svc === 'dsh' ? services.restartDsh() : services.restartLlm())
    .catch(error => console.error(`[launcher] ${svc} 重启失败:`, error?.stack ?? error))
})

route('GET', /^\/api\/services\/events$/, (req, res) => {
  const stream = sse(res)
  for (const evt of services.serviceEventHistory) stream.send('service', evt) // 回放历史，防漏早期阶段
  const onService = evt => stream.send('service', evt)
  services.serviceEvents.on('service', onService)
  res.on('close', () => services.serviceEvents.off('service', onService))
})

route('GET', /^\/api\/logs\/(llm|dsh)$/, (req, res, m) =>
  streamLog(res, m[1] === 'llm' ? 'llm.out.log' : 'dsh.out.log'))

route('GET', /^\/api\/config$/, (req, res) => sendJson(res, 200, readConfig()))
route('PUT', /^\/api\/config$/, async (req, res) => {
  try {
    const body = await readBody(req)
    writeConfig(body)
    syncSettings()
    sendJson(res, 200, readConfig())
  } catch (error) { sendError(res, 400, error.message) }
})

route('GET', /^\/api\/models$/, (req, res) => sendJson(res, 200, listModels()))
route('POST', /^\/api\/models\/switch$/, async (req, res) => {
  try {
    const body = await readBody(req)
    sendJson(res, 200, switchModel(String(body.name ?? '')))
  } catch (error) { sendError(res, 400, error.message) }
})
route('DELETE', /^\/api\/models\/([^/]+)$/, (req, res, m) => {
  try { sendJson(res, 200, deleteModel(decodeURIComponent(m[1]))) } catch (error) { sendError(res, 400, error.message) }
})
route('POST', /^\/api\/models\/import$/, async (req, res) => {
  try {
    const body = await readBody(req)
    const source = String(body.path ?? '')
    if (!source || !/\.gguf$/i.test(source)) throw new Error('请提供 .gguf 文件路径')
    if (!existsSync(source)) throw new Error(`文件不存在：${source}`)
    const name = basename(source)
    const dest = join(DIRS.models, name)
    if (existsSync(dest)) throw new Error('同名模型已存在')
    mkdirSync(DIRS.models, { recursive: true })
    copyFileSync(source, dest)
    sendJson(res, 200, { name, size: statSync(dest).size })
  } catch (error) { sendError(res, 400, error.message) }
})

route('GET', /^\/api\/hub\/search$/, async (req, res) => {
  try {
    const query = new URL(req.url, 'http://127.0.0.1').searchParams
    sendJson(res, 200, await hub.hubSearch(query.get('q') ?? '', Number(query.get('page')) || 0))
  } catch (error) { sendError(res, error.status ?? 502, error.message) }
})

// 文件列表 + 按本机硬件的下载建议（recommend）
route('GET', /^\/api\/hub\/files\/([^/]+)$/, async (req, res, m) => {
  try {
    const files = await hub.hubFiles(decodeURIComponent(m[1]))
    const recommend = await hub.hubRecommend(files).catch(() => null)
    sendJson(res, 200, { files, recommend })
  } catch (error) { sendError(res, error.status ?? 502, error.message) }
})

// 仓库介绍：README 简介 + license
route('GET', /^\/api\/hub\/info\/([^/]+)$/, async (req, res, m) => {
  try { sendJson(res, 200, await hub.hubInfo(decodeURIComponent(m[1]))) } catch (error) { sendError(res, error.status ?? 502, error.message) }
})

route('GET', /^\/api\/downloads$/, (req, res) => sendJson(res, 200, downloads.taskList()))
route('POST', /^\/api\/downloads$/, async (req, res) => {
  try {
    const body = await readBody(req)
    const url = String(body.url ?? '')
    if (!url) throw new Error('缺少下载 URL')
    let dest = String(body.dest ?? '')
    if (!dest) {
      dest = join(DIRS.models, basename(new URL(url).pathname))
    } else if (!/^[a-zA-Z]:[\\/]/.test(dest) && !dest.startsWith('\\\\')) {
      dest = join(ROOT, dest)
    }
    sendJson(res, 200, downloads.startDownload({ url, dest, label: String(body.label ?? 'download') }))
  } catch (error) { sendError(res, 400, error.message) }
})
route('POST', /^\/api\/downloads\/([^/]+)\/cancel$/, (req, res, m) => {
  sendJson(res, 200, { ok: downloads.cancelDownload(decodeURIComponent(m[1])) })
})
route('GET', /^\/api\/downloads\/events$/, (req, res) => {
  const stream = sse(res)
  for (const task of downloads.taskList()) stream.send('task', task)
  const onTask = task => stream.send('task', task)
  downloads.downloadEvents.on('task', onTask)
  res.on('close', () => downloads.downloadEvents.off('task', onTask))
})

route('POST', /^\/api\/chat\/test$/, async (req, res) => {
  try {
    const body = await readBody(req)
    const stream = sse(res)
    await chat.chatTest(body, evt => stream.send(evt.type, evt.data))
    stream.close()
  } catch (error) {
    if (!res.headersSent) sendError(res, error.status ?? 500, error.message)
    else res.end()
  }
})

route('GET', /^\/api\/harness\/url$/, (req, res) => {
  let url = null
  try { url = readFileSync(join(DIRS.logs, 'dsh.url'), 'utf8').trim() } catch { /* 未运行 */ }
  sendJson(res, 200, { url })
})
route('POST', /^\/api\/harness\/open$/, (req, res) => {
  let url = null
  try { url = readFileSync(join(DIRS.logs, 'dsh.url'), 'utf8').trim() } catch { /* 未运行 */ }
  if (url) openBrowser(url)
  sendJson(res, 200, { url, opened: Boolean(url) })
})

route('GET', /^\/api\/versions$/, (req, res) => sendJson(res, 200, versions.versionSummary()))
route('POST', /^\/api\/update\/(harness|llama|node|launcher)\/check$/, async (req, res, m) => {
  try { sendJson(res, 200, await versions.checkUpdate(m[1])) } catch (error) { sendError(res, 502, error.message) }
})
route('POST', /^\/api\/update\/(harness|llama|node|launcher)\/update$/, async (req, res, m) => {
  // 更新可能耗时数分钟：立即返回 202，异步执行，进度与结果走 SSE。
  if (versions.isUpdateRunning()) return sendError(res, 409, '已有更新任务进行中，请稍候。')
  sendJson(res, 202, { started: true })
  void versions.updateComponent(m[1]).catch(error => {
    versions.updateEvents.emit('event', { component: m[1], type: 'error', line: error?.message ?? String(error), ts: Date.now() })
    console.error(`[launcher] update ${m[1]} 失败:`, error?.stack ?? error)
  })
})
route('POST', /^\/api\/update\/(harness|llama|node|launcher)\/rollback$/, async (req, res, m) => {
  try { sendJson(res, 200, await versions.rollbackComponent(m[1])) } catch (error) { sendError(res, 500, error.message) }
})
route('GET', /^\/api\/update\/events$/, (req, res) => {
  const stream = sse(res)
  const onEvent = evt => stream.send('event', evt)
  versions.updateEvents.on('event', onEvent)
  res.on('close', () => versions.updateEvents.off('event', onEvent))
})

route('GET', /^\/api\/launcher\/info$/, (req, res) => sendJson(res, 200, launcherUpdate.launcherInfo()))
// 重启生效（electron relaunch）：退出前把运行中的服务状态落盘，
// 新实例启动时自动恢复 —— dsh 靠浏览器 cookie（data\.credentials.yaml）
// 还原 agent 会话，正在对话的窗口刷新后继续。
const SERVICE_STATE_FILE = join(DIRS.data, 'launcher-services.json')

route('POST', /^\/api\/launcher\/restart$/, (req, res) => {
  const r = launcherUpdate.requestRelaunch()
  sendJson(res, r?.ok === false ? 500 : 200, r ?? { ok: true })
})

route('POST', /^\/api\/quit$/, (req, res) => {
  sendJson(res, 200, { ok: true })
  void shutdown('api-quit')
})

// Win11 24H2+ 的资源管理器会为每次打开创建独立进程/窗口，且窗口常常停在
// 隐藏或后台状态，用户看不到。open-dir-helper.ps1 负责：找到（或等 start 创建）
// 显示目标文件夹的窗口 → 显示 + SetForegroundWindow，并清理同文件夹的重复隐藏窗口。
const OPEN_DIR_HELPER = join(dirname(fileURLToPath(import.meta.url)), 'open-dir-helper.ps1')
const OPEN_DIR_HELPER_LOG = join(DIRS.logs, 'open-dir-helper.log')

route('POST', /^\/api\/open-dir$/, async (req, res) => {
  try {
    const body = await readBody(req)
    const map = { data: DIRS.data, logs: DIRS.logs, models: DIRS.models, root: ROOT, harness: DIRS.harness, config: DIRS.config }
    const dir = map[String(body.path ?? '')]
    if (!dir) throw new Error('无效目录')
    if (existsSync(OPEN_DIR_HELPER)) {
      const ps = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
      spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OPEN_DIR_HELPER, dir, OPEN_DIR_HELPER_LOG], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref()
    } else {
      // 回退：ShellExecute（start）。窗口可能不前置，但至少能打开。
      spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', 'start', '', dir], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref()
    }
    sendJson(res, 200, { ok: true })
  } catch (error) { sendError(res, 400, error.message) }
})

// ---------- 静态资源 ----------

function serveStatic(res, pathname) {
  const safe = (pathname === '/' ? 'index.html' : pathname).replace(/^\/+/, '').replace(/\.\./g, '')
  const file = join(DIRS.gui, safe)
  if (!existsSync(file) || !file.startsWith(DIRS.gui)) {
    return sendError(res, 404, '页面不存在')
  }
  try {
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  } catch {
    sendError(res, 500, '读取页面失败')
  }
}

// ---------- 生命周期 ----------

let shuttingDown = false
export async function shutdown(reason = 'shutdown') {
  if (shuttingDown) return
  shuttingDown = true
  // 退出前落盘运行中的服务（任何退出原因：关窗、重启、api-quit），
  // 新实例启动时自动恢复 —— 用户退出前手动停掉的服务状态为 false，不会误拉起。
  try {
    const svc = {
      dsh: services.dshStatus().running === true,
      llm: (await services.llmStatus()).running === true,
    }
    if (svc.dsh || svc.llm) {
      writeFileSync(SERVICE_STATE_FILE, JSON.stringify(svc, null, 2), 'utf8')
      console.log(`[launcher] 已保存服务状态（下次启动自动恢复）: dsh=${svc.dsh} llm=${svc.llm}`)
    }
  } catch (error) { console.warn('[launcher] 保存服务状态失败:', error.message) }
  console.log(`[launcher] ${reason}：正在停止全部子进程……`)
  try { downloads.stopAllDownloads() } catch { /* 忽略 */ }
  try { await services.stopAll() } catch { /* 忽略 */ }
  console.log('[launcher] 已退出')
  setTimeout(() => process.exit(0), 500)
}

// 新实例启动后消费服务状态文件：自动拉起上次退出前运行中的服务
async function consumeServiceState() {
  let svc = null
  try {
    if (existsSync(SERVICE_STATE_FILE)) {
      svc = JSON.parse(readFileSync(SERVICE_STATE_FILE, 'utf8'))
      unlinkSync(SERVICE_STATE_FILE)
    }
  } catch { svc = null }
  if (!svc) return
  console.log(`[launcher] 自动恢复服务: llm=${!!svc.llm} dsh=${!!svc.dsh}`)
  if (svc.llm) services.startLlm().catch(error => console.warn('[launcher] 自动恢复 llm 失败:', error.message))
  if (svc.dsh) {
    // 旧 dsh 可能还在退出、端口尚未释放：先等端口空闲再拉起，
    // 避免「端口已被占用」导致自动恢复静默失败。
    const cfg = readConfig()
    const dshPort = Number(cfg.DSH_PORT) || 3080
    const free = await waitPortFree(dshPort, 15000)
    console.log(`[launcher] dsh 端口 ${dshPort} ${free ? '已空闲' : '仍被占用'}`)
    services.startDsh({ openBrowser: false, allowPortFallback: false })
      .then(() => console.log('[launcher] 自动恢复 dsh 成功'))
      .catch(error => console.warn('[launcher] 自动恢复 dsh 失败:', error.message))
  }
}

export function startServer({ port = 0, onRelaunch = null } = {}) {
  ensureDirs()
  if (onRelaunch) launcherUpdate.setRelaunch(onRelaunch)
  writeFileSync(TOKEN_FILE, token, 'ascii')
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    try {
      if (pathname === '/api/ping') return sendJson(res, 200, { ok: true })
      if (!pathname.startsWith('/api/')) return serveStatic(res, pathname)
      if (!authorized(req, req.url ?? '/')) return sendError(res, 401, '需要访问令牌（logs\\launcher.token）')
      for (const r of routes) {
        const m = r.pattern.exec(pathname)
        if (m && r.method === req.method) {
          await r.handler(req, res, m)
          return
        }
      }
      sendError(res, 404, '接口不存在')
    } catch (error) {
      if (!res.headersSent) sendError(res, 500, error.message)
      else res.end()
    }
  })
  server.on('error', error => {
    if (error.code === 'EADDRINUSE' && !server.address()) {
      console.warn(`[launcher] 端口 ${port} 被占用，改用随机端口`)
      server.listen(0, '127.0.0.1')
      return
    }
    console.error('[launcher] HTTP 服务错误:', error.message)
  })
  return new Promise(resolveServer => {
    server.listen(port, '127.0.0.1', () => {
      setTimeout(() => consumeServiceState(), 1000)
      resolveServer({ server, port: server.address().port, token })
    })
  })
}

function openBrowser(url) {
  spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', 'start', '', url], {
    detached: true, stdio: 'ignore', windowsHide: true,
  }).unref()
}

// ---------- 独立运行模式 ----------

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) {
  ensureDirs()
  const args = process.argv.slice(2)
  const browser = args.includes('--browser')
  const portArg = args.find(a => a.startsWith('--port='))
  const port = portArg ? Number(portArg.slice('--port='.length)) : Number(readConfig().LAUNCHER_PORT) || 7610
  // 独立 Node 模式的「重启生效」：停止服务退出，在 exit 事件里拉起新实例
  // （此时端口已释放，避免新实例 EADDRINUSE 落到随机端口）。
  const started = await startServer({
    port,
    onRelaunch: () => {
      process.once('exit', () => {
        const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), ...(browser ? ['--browser'] : [])], {
          detached: true, stdio: 'ignore', windowsHide: true,
        }).unref()
        console.log(`[launcher] 已拉起新实例（pid ${proc.pid}），当前进程退出`)
      })
      console.log('[launcher] 重启生效：正在停止服务并退出……')
      void shutdown('relaunch')
    },
  })
  const url = `http://127.0.0.1:${started.port}/?token=${started.token}`
  console.log(`[launcher] 启动器已启动: ${url}`)
  console.log('[launcher] 关闭窗口或 Ctrl+C 即退出，退出时自动停止全部服务')
  if (browser) openBrowser(url)
  process.on('SIGINT', () => void shutdown('sigint'))
  process.on('SIGTERM', () => void shutdown('sigterm'))
}
