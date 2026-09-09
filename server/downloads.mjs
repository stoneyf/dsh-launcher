/**
 * 下载管理：curl.exe 断点续传 + 进度轮询 + 取消/续传。
 * 事件经 events 总线广播，由 main.mjs 转为 SSE。
 */
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createWriteStream, statSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DIRS, logPath } from './core.mjs'

export const downloadEvents = new EventEmitter()

const tasks = new Map()
let seq = 0

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

async function headTotal(url) {
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
export function startDownload({ url, dest, label = 'download' }) {
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
        downloadEvents.emit('task', serialize(t))
        return
      }
      t.total = await headTotal(url)
      const proc = spawn(
        curlExe(),
        ['-L', '--ssl-no-revoke', '--retry', '8', '--retry-delay', '3', '-C', '-', '-o', part, url],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      )
      t.proc = proc
      proc.stderr.pipe(createWriteStream(logPath('downloads.log'), { flags: 'a' }))
      proc.on('error', error => {
        t.error = error.message
        t.state = 'failed'
        t.finishedAt = Date.now()
        downloadEvents.emit('task', serialize(t))
      })
      t.timer = setInterval(() => {
        try {
          t.downloaded = statSync(part).size
          downloadEvents.emit('task', serialize(t))
        } catch { /* 文件未创建 */ }
      }, 1000)
      proc.on('exit', code => {
        clearInterval(t.timer)
        if (t.state === 'cancelled') {
          t.finishedAt = Date.now()
          downloadEvents.emit('task', serialize(t))
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
        downloadEvents.emit('task', serialize(t))
      })
    } catch (error) {
      t.state = 'failed'
      t.error = error.message
      t.finishedAt = Date.now()
      downloadEvents.emit('task', serialize(t))
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
  downloadEvents.emit('task', serialize(t))
  return true
}

export function stopAllDownloads() {
  for (const id of [...tasks.keys()]) cancelDownload(id)
}

/** 独立下载（供版本更新等模块复用）：返回 Promise，成功 resolve(dest)。 */
export function downloadTo(url, dest, { label = 'download', onProgress = null } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const task = startDownload({ url, dest, label })
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
