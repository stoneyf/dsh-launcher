/**
 * 对话管理：列出 / 删除 / 清空会话（dsh 把每个会话存在 data\sessions\<profile>\<id>\）。
 * 仅操作磁盘上的会话文件；正在写文件的会话若被锁则跳过（Windows 文件锁）。
 */
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS } from './core.mjs'

export const SESSIONS_DIR = join(DIRS.data, 'sessions')

/** 列出所有会话：{ id, profile, dir, size, updatedAt }，按最近修改倒序。 */
export function listSessions() {
  const items = []
  if (!existsSync(SESSIONS_DIR)) return items
  let profiles = []
  try {
    profiles = readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
  } catch { return items }
  for (const profile of profiles) {
    let sessions = []
    try {
      sessions = readdirSync(join(SESSIONS_DIR, profile), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    } catch { continue }
    for (const id of sessions) {
      const dir = join(SESSIONS_DIR, profile, id)
      let size = 0, updatedAt = null
      let files = []
      try { files = readdirSync(dir) } catch { continue }
      for (const f of files) {
        try {
          const st = statSync(join(dir, f))
          size += st.size
          if (st.mtimeMs > (updatedAt ?? 0)) updatedAt = st.mtimeMs
        } catch { /* 忽略 */ }
      }
      items.push({ id, profile, dir, size, updatedAt })
    }
  }
  items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return items
}

function tryRemove(dir) {
  try { rmSync(dir, { recursive: true, force: true }); return true }
  catch { return false } // 被占用（正在写入的会话）则跳过
}

/** 删除单个会话（按 id 在任意 profile 下查找）。 */
export function deleteSession(id) {
  if (!existsSync(SESSIONS_DIR)) throw new Error('没有会话目录')
  for (const profile of readdirSync(SESSIONS_DIR)) {
    const dir = join(SESSIONS_DIR, profile, id)
    if (existsSync(dir)) {
      if (!tryRemove(dir)) throw new Error(`会话正被占用，无法删除：${id}`)
      return { deleted: id }
    }
  }
  throw new Error('找不到会话：' + id)
}

/** 清空全部会话（跳过被占用的）。返回删除计数。 */
export function clearSessions() {
  if (!existsSync(SESSIONS_DIR)) return { deleted: 0, skipped: 0 }
  const total = listSessions().length
  let deleted = 0, skipped = 0
  for (const profile of readdirSync(SESSIONS_DIR)) {
    let sessions = []
    try { sessions = readdirSync(join(SESSIONS_DIR, profile), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { continue }
    for (const id of sessions) {
      if (tryRemove(join(SESSIONS_DIR, profile, id))) deleted++
      else skipped++
    }
  }
  return { deleted, skipped, total }
}
