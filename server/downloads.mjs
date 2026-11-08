/**
 * 下载管理：curl.exe 断点续传 + 进度轮询 + 取消/续传。
 * 事件经 events 总线广播，由 main.mjs 转为 SSE。
 */
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createWriteStream, statSync, renameSync, existsSync, mkdirSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DIRS, logPath, readConfig } from './core.mjs'

export const downloadEvents = new EventEmitter()

const tasks = new Map()
let seq = 0

/** 任务账本落盘位置（4.4.5）：只在**非 running** 状态写盘。
 *  为什么需要：任务表原本只在内存里，启动器一重启/崩溃，未完成的下载就从界面上凭空消失
 *  （.part 断点其实还在，但用户不知道有这回事、也没法点续传）。 */
const storeFile = () => join(DIRS.logs, 'downloads.json')

function persist() {
  try {
    const rows = [...tasks.values()].filter(t => t.state !== 'running').map(serialize)
    writeFileSync(storeFile(), JSON.stringify(rows, null, 2), 'utf8')
  } catch { /* 落盘失败不影响下载本身 */ }
}

/** 启动时恢复上一次未结束的下载任务：重启前 running 的记为 paused（可点续传）。 */
export function restoreTasks() {
  let rows = []
  try { rows = JSON.parse(readFileSync(storeFile(), 'utf8')) } catch { return 0 }
  if (!Array.isArray(rows)) return 0
  let n = 0
  for (const r of rows) {
    if (!r || !r.id || !r.url || !r.dest) continue
    if (r.state === 'done') continue          // 完成的不恢复（模型已在磁盘上，重启后重新扫描即可）
    const m = /^dl-(\d+)$/.exec(String(r.id))
    if (m) seq = Math.max(seq, Number(m[1]))  // 接着上次的编号，避免 id 撞车
    tasks.set(r.id, {
      id: r.id,
      label: r.label ?? 'download',
      url: r.url,
      dest: r.dest,
      state: 'paused',
      downloaded: Number(r.downloaded) || 0,
      total: Number(r.total) || null,
      error: null,
      startedAt: Number(r.startedAt) || Date.now(),
      finishedAt: r.finishedAt ?? null,
      proc: null,
      timer: null,
    })
    n++
  }
  return n
}

/** 统一的“发事件”出口：非 running 状态顺手落盘（running 每秒都在变，不写）。 */
function emit(t) {
  const s = serialize(t)
  if (s.state !== 'running') persist()
  downloadEvents.emit('task', s)
}

function curlExe() {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe')
}

function serialize(t) {
  return {
    id: t.id,
    label: t.label,
    url: t.url,
    fileName: basename(t.dest),
    dest: t.dest,
    state: t.state,
    downloaded: t.downloaded,
    total: t.total,
    error: t.error ?? null,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt ?? null,
  }
}

export function taskList() {
  return [...tasks.values()].map(serialize)
}

/**
 * 用 curl 直接取文本（head=true 取响应头，否则取响应体），失败返回 null。
 * 用途：配置了 DOWNLOAD_PROXY 时，Node 的 fetch 不走系统/指定代理，改用 curl。
 */
export function curlText(url, { proxy = '', head = false, timeoutSec = 12 } = {}) {
  return new Promise(resolve => {
    const args = ['-s', head ? 'I' : 'L', '--ssl-no-revoke', '--max-time', String(timeoutSec)]
    if (proxy) args.push('-x', proxy)
    args.push(url)
    let proc
    try {
      proc = spawn(curlExe(), args, { windowsHide: true })
    } catch {
      return resolve(null)
    }
    let out = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', chunk => { out += chunk })
    proc.stderr.on('data', () => {})
    proc.on('error', () => resolve(null))
    proc.on('exit', code => resolve(code === 0 ? out : null))
  })
}

/**
 * 决定某个下载 URL 该用哪个代理（返回 '' = 直连）。
 * 中国镜像（hf-mirror 等）直连更快，GitHub 相关域名走代理（国内直连 GitHub
 * 大文件经常被掐断，exit 56），但 GitHub 发布页/asset 大文件（>100MB）直连
 * 更快。按策略：
 *   ① hf-mirror / DIRECT_HOSTS → 直连（比绕海外代理快）
 *   ② GitHub asset / release → 直连（代理 165MB zip 频繁断连 exit 56/33/18）
 *   ③ 其余 → 走 DOWNLOAD_PROXY
 */
export function proxyForUrl(url, cfg) {
  const proxy = (cfg?.DOWNLOAD_PROXY ?? '').trim()
  if (!proxy) return ''
  try {
    const host = new URL(url).host.split(':')[0].toLowerCase()
    const direct = new Set()
    const hubHost = (cfg?.HUB_MIRROR || 'https://hf-mirror.com')
      .replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
    if (hubHost) direct.add(hubHost)
    for (const h of String(cfg?.DIRECT_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) direct.add(h)
    // ② 直连域名：GitHub 发布页/asset（代理 165MB zip 频繁断连 exit 56/33/18）
    //    + 国内镜像（ghproxy / gh-proxy / ghfast 走代理也只有 370KB/s，直接走镜像更快）
    if (host === 'github.com' || host === 'githubusercontent.com') return ''
    if (host === 'ghproxy.net' || host === 'gh-proxy.com' || host === 'ghfast.top') return ''
    for (const dh of direct) {
      if (host === dh || host.endsWith('.' + dh)) return ''
    }
  } catch { /* URL 解析失败 → 走代理 */ }
  return proxy
}

/**
 * 用 curl 试拉一小段（默认 2MB）测速，返回字节/秒；拿不到返回 0。
 * 用途：同一 URL 比较「直连」与「代理」谁快，按用户要求择快下载、失败再换另一条。
 */
export function probeSpeed(url, proxy = '', { maxBytes = 2 * 1024 * 1024, timeoutSec = 20 } = {}) {
  return new Promise(resolve => {
    const args = ['-s', '-L', '--ssl-no-revoke', '--max-time', String(timeoutSec), '--range', `0-${maxBytes - 1}`, '-o', 'NUL', '-w', '%{speed_download}']
    if (proxy) args.push('-x', proxy)
    args.push(url)
    let proc
    try {
      proc = spawn(curlExe(), args, { windowsHide: true })
    } catch { return resolve(0) }
    let out = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', chunk => { out += chunk })
    proc.stderr.on('data', () => {})
    proc.on('error', () => resolve(0))
    proc.on('exit', code => {
      const v = Number(String(out).trim())
      resolve(code === 0 && Number.isFinite(v) && v > 0 ? v : 0)
    })
  })
}

/**
 * 对同一 URL 比较「直连」与「代理」速度，返回按快慢排序的路由（proxy 值为 '' 表示直连）。
 * 实测都拿不到速度时保持默认顺序（直连 → 代理），由调用方逐个尝试。
 */
export async function rankRoutes(url, cfg) {
  const proxy = (cfg?.DOWNLOAD_PROXY ?? '').trim()
  const direct = await probeSpeed(url, '')
  const viaProxy = proxy ? await probeSpeed(url, proxy) : 0
  const routes = [{ proxy: '', speed: direct }]
  if (proxy) routes.push({ proxy, speed: viaProxy })
  routes.sort((a, b) => b.speed - a.speed)
  return routes
}

/**
 * 模型下载优先国内镜像：把 huggingface.co 的直链改写成 HUB_MIRROR（默认 hf-mirror.com）。
 * 用户要求（2026-10-29）：模型下载优先国内镜像源。其它域名原样返回。
 */
export function preferDomesticMirror(url, cfg) {
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return url
    if (u.hostname.toLowerCase() !== 'huggingface.co') return url
    const mirror = String(cfg?.HUB_MIRROR || 'https://hf-mirror.com').replace(/\/+$/, '')
    if (!mirror) return url
    const m = new URL(mirror)
    u.protocol = m.protocol
    u.host = m.host
    return u.toString()
  } catch { return url }
}

async function headTotal(url, proxy = '') {
  if (proxy) {
    const out = await curlText(url, { proxy, head: true, timeoutSec: 12 })
    if (!out) return null
    const m = /content-length:\s*(\d+)/im.exec(out)
    return m ? Number(m[1]) : null
  }
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(25000) })
    const len = Number(res.headers.get('content-length'))
    return len > 0 ? len : null
  } catch { return null }
}

/**
 * 开始（或续传）一个下载任务。
 * @param {{url: string, dest: string, label?: string}} options
 */
export function startDownload({ url, dest, label = 'download', proxy: proxyOverride = undefined }) {
  // 模型下载优先国内镜像：huggingface.co → HUB_MIRROR（默认 hf-mirror.com）
  const cfg = readConfig()
  url = preferDomesticMirror(url, cfg)
  const id = `dl-${++seq}`
  const part = `${dest}.part`
  mkdirSync(dirname(dest), { recursive: true })
  const t = {
    id,
    label,
    url,
    dest,
    state: 'running',
    downloaded: existsSync(part) ? statSync(part).size : 0,
    total: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    proc: null,
    timer: null,
  }
  tasks.set(id, t)
  downloadEvents.emit('task', serialize(t))

  void (async () => {
    // 关键：async 函数体在首个 await 前同步执行。立即推迟到微任务，
    // 保证调用方（如 downloadTo）在收到事件前完成订阅。
    await Promise.resolve()
    try {
      // 已完整且无 .part 残留 → 直接视为完成
      if (existsSync(dest) && !existsSync(part)) {
        t.downloaded = statSync(dest).size
        t.total = t.downloaded
        t.state = 'done'
        t.finishedAt = Date.now()
        emit(t)
        return
      }
      // 中国镜像（hf-mirror 等）直连更快，proxyForUrl 自动判定是否绕过代理。
      // proxyOverride 是调用方测速后显式选定的路由（'' = 直连）。
      const proxy = proxyOverride !== undefined ? proxyOverride : proxyForUrl(url, cfg)
      t.total = await headTotal(url, proxy)
      // --retry-all-errors：GitHub 大文件经常在传输中被掐断（curl exit 56 schannel
      // "server closed abruptly"），默认 --retry 不重试这类错误，会直接判失败；
      // 加上后 curl 自己会用 -C - 续传重试，配合 20 次重试足以扛过抖动。
      const dlArgs = ['-L', '--ssl-no-revoke', '--retry', '20', '--retry-delay', '2', '--retry-all-errors', '-C', '-', '-o', part]
      if (proxy) dlArgs.push('-x', proxy)
      dlArgs.push(url)
      const proc = spawn(curlExe(), dlArgs, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      t.proc = proc
      proc.stderr.pipe(createWriteStream(logPath('downloads.log'), { flags: 'a' }))
      proc.on('error', error => {
        t.error = error.message
        t.state = 'failed'
        t.finishedAt = Date.now()
        emit(t)
      })
      t.timer = setInterval(() => {
        try {
          t.downloaded = statSync(part).size
          emit(t)
        } catch { /* 文件未创建 */ }
      }, 1000)
      proc.on('exit', code => {
        clearInterval(t.timer)
        if (t.state === 'cancelled') {
          t.finishedAt = Date.now()
          emit(t)
          return
        }
        if (code === 0) {
          try {
            renameSync(part, dest)
            t.downloaded = statSync(dest).size
            t.state = 'done'
          } catch (error) {
            t.state = 'failed'
            t.error = `完成后重命名失败：${error.message}`
          }
        } else {
          t.state = 'failed'
          t.error = `curl 退出码 ${code}（可再次启动续传）`
        }
        t.finishedAt = Date.now()
        emit(t)
      })
    } catch (error) {
      t.state = 'failed'
      t.error = error.message
      t.finishedAt = Date.now()
      emit(t)
    }
  })()

  return serialize(t)
}

export function cancelDownload(id) {
  const t = tasks.get(id)
  if (!t || t.state !== 'running') return false
  t.state = 'cancelled'
  try { t.proc?.kill('SIGTERM') } catch { /* 已退出 */ }
  setTimeout(() => {
    try { t.proc?.kill('SIGKILL') } catch { /* 已退出 */ }
  }, 3000)
  emit(t)
  return true
}

export function stopAllDownloads() {
  for (const id of [...tasks.keys()]) cancelDownload(id)
}

/** 删除任务：停止 + 移除记录 + 清掉 .part 断点文件。已完成任务的成品模型保留（避免误删）。 */
export function deleteTask(id) {
  const t = tasks.get(id)
  if (!t) return { deleted: false }
  if (t.timer) clearInterval(t.timer)
  try { t.proc?.kill('SIGTERM') } catch { /* 已退出 */ }
  try {
    const part = `${t.dest}.part`
    if (existsSync(part)) unlinkSync(part)
  } catch { /* 忽略 */ }
  tasks.delete(id)
  persist()   // 账本里也要移除，否则重启后又被「恢复」出来
  downloadEvents.emit('task', { ...serialize(t), state: 'deleted' })
  return { deleted: true }
}

/** 独立下载（供版本更新等模块复用）：返回 Promise，成功 resolve(dest)。 */
export function downloadTo(url, dest, { label = 'download', onProgress = null, proxy = undefined } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const task = startDownload({ url, dest, label, proxy })
    const settle = t => {
      if (onProgress) onProgress(t)
      if (t.state === 'done') {
        downloadEvents.off('task', onTask)
        resolvePromise(dest)
      } else if (t.state === 'failed' || t.state === 'cancelled') {
        downloadEvents.off('task', onTask)
        rejectPromise(new Error(t.error ?? `下载未完成（${t.state}）`))
      }
    }
    const onTask = t => {
      if (t.id !== task.id) return
      settle(t)
    }
    downloadEvents.on('task', onTask)
    // 防御：若任务在订阅前已同步进入终态，直接结算
    const current = tasks.get(task.id)
    if (current && current.state !== 'running') settle(serialize(current))
  })
}
