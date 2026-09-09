/**
 * ZIP / TAR(GZ) 处理工具（零依赖）：
 *  - fetchZipEntries: 按 HTTP Range 分片抓取 zip 内指定条目
 *  - extractZip: 解压本地 zip（stored + deflate）
 *  - extractTarGz: 解压 npm tgz（tar + gzip），支持选择性提取
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inflateRawSync, gunzipSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/** 解析 zip 中央目录。 */
export function parseZipCentral(cdBuf) {
  const entries = []
  let off = 0
  while (off + 46 <= cdBuf.length) {
    if (cdBuf.readUInt32LE(off) !== CEN_SIG) break
    const method = cdBuf.readUInt16LE(off + 10)
    const compSize = cdBuf.readUInt32LE(off + 20)
    const uncompSize = cdBuf.readUInt32LE(off + 24)
    const nameLen = cdBuf.readUInt16LE(off + 28)
    const extraLen = cdBuf.readUInt16LE(off + 30)
    const commentLen = cdBuf.readUInt16LE(off + 32)
    const localOffset = cdBuf.readUInt32LE(off + 42)
    const name = cdBuf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    entries.push({ name, method, compSize, uncompSize, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function fetchRangeWithRetry(zipUrl, range, attempts = 4) {
  let lastError = null
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(zipUrl, {
        headers: { Range: range },
        redirect: 'follow',
        signal: AbortSignal.timeout(90000),
      })
      const buf = Buffer.from(await res.arrayBuffer())
      if (res.status === 206) {
        const m = res.headers.get('content-range')?.match(/bytes \d+-\d+\/(\d+)/)
        return { status: 206, size: m ? Number(m[1]) : null, buf }
      }
      return { status: res.status, size: null, buf }
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }
  throw lastError ?? new Error('range fetch failed')
}

/**
 * 分片抓取 zip 内指定条目到 destDir。
 * @param {string} zipUrl
 * @param {string} destDir
 * @param {{existingDir?: string, wanted?: (name: string) => boolean, onEntry?: (name: string) => void}} options
 *   wanted 缺省时抓取所有条目；existingDir 中的同名文件（小写比较）跳过。
 */
export async function fetchZipEntries(zipUrl, destDir, options = {}) {
  const { existingDir = null, wanted = null, onEntry = null } = options
  mkdirSync(destDir, { recursive: true })
  const have = new Set()
  if (existingDir && existsSync(existingDir)) {
    const { readdirSync } = await import('node:fs')
    for (const n of readdirSync(existingDir)) have.add(n.toLowerCase())
  }
  const MIN_TAIL = 65536
  let tail = await fetchRangeWithRetry(zipUrl, `bytes=-${MIN_TAIL}`)
  if (tail.status !== 206) throw new Error(`服务器不支持 Range（HTTP ${tail.status}），无法分片抓取`)
  let tailBuf = tail.buf
  let zipSize = tail.size
  let eocdInTail = findEocd(tailBuf)
  for (let i = 0; i < 4 && eocdInTail < 0; i++) {
    tail = await fetchRangeWithRetry(zipUrl, `bytes=-${tailBuf.length * 4}`)
    if (tail.status !== 206) break
    tailBuf = tail.buf
    zipSize = tail.size ?? zipSize
    eocdInTail = findEocd(tailBuf)
  }
  if (eocdInTail < 0) throw new Error('zip 尾部找不到中央目录')
  const tailStart = zipSize - tailBuf.length
  const cdSize = tailBuf.readUInt32LE(eocdInTail + 12)
  const cdOffset = tailBuf.readUInt32LE(eocdInTail + 16)
  const cdEnd = cdOffset + cdSize
  let cdBuf
  if (cdOffset < tailStart) {
    const extra = await fetchRangeWithRetry(zipUrl, `bytes=${cdOffset}-${tailStart - 1}`)
    if (extra.status !== 206) throw new Error('补齐中央目录失败')
    cdBuf = Buffer.concat([extra.buf, tailBuf.subarray(0, cdEnd - tailStart)])
  } else {
    cdBuf = tailBuf.subarray(cdOffset - tailStart, cdEnd - tailStart)
  }
  const entries = parseZipCentral(cdBuf)
  const wantedEntries = entries.filter(e => {
    const base = e.name.split('/').pop()
    if (!base) return false
    if (have.has(base.toLowerCase())) return false
    return wanted ? wanted(base) : true
  })
  const CHUNK = 1048576
  const fetched = []
  for (const entry of wantedEntries) {
    const base = entry.name.split('/').pop()
    const destPath = join(destDir, base)
    if (existsSync(destPath) && statSync(destPath).size === entry.uncompSize) continue
    const start = entry.localOffset
    const head = await fetchRangeWithRetry(zipUrl, `bytes=${start}-${start + 30 + 4096}`)
    if (head.status !== 206 || head.buf.readUInt32LE(0) !== LOC_SIG) throw new Error(`${base}: 本地头获取失败`)
    const lNameLen = head.buf.readUInt16LE(26)
    const lExtraLen = head.buf.readUInt16LE(28)
    const dataStartAbs = start + 30 + lNameLen + lExtraLen
    let data
    if (entry.compSize > CHUNK) {
      const parts = []
      for (let off = 0; off < entry.compSize; off += CHUNK) {
        const chunkEnd = Math.min(off + CHUNK, entry.compSize) - 1
        const r = await fetchRangeWithRetry(zipUrl, `bytes=${dataStartAbs + off}-${dataStartAbs + chunkEnd}`)
        if (r.status !== 206) throw new Error(`${base}: 分块 ${off} 失败（HTTP ${r.status}）`)
        parts.push(r.buf)
      }
      data = Buffer.concat(parts)
    } else {
      const r = await fetchRangeWithRetry(zipUrl, `bytes=${dataStartAbs}-${dataStartAbs + entry.compSize - 1}`)
      if (r.status !== 206) throw new Error(`${base}: 数据获取失败（HTTP ${r.status}）`)
      data = r.buf
    }
    if (data.length !== entry.compSize) throw new Error(`${base}: 数据不完整 ${data.length}/${entry.compSize}`)
    const out = entry.method === 8 ? inflateRawSync(data) : data
    if (out.length !== entry.uncompSize) throw new Error(`${base}: 解压大小不符`)
    writeFileSync(destPath, out)
    fetched.push(base)
    if (onEntry) onEntry(base)
  }
  return fetched
}

/** 解压本地 zip（支持 stored 与 deflate）。 */
export function extractZip(zipPath, destDir, { strip = 0, onEntry = null } = {}) {
  const buf = readFileSync(zipPath)
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('无效 zip：找不到 EOCD')
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = parseZipCentral(buf.subarray(cdOffset, cdOffset + cdSize))
  mkdirSync(destDir, { recursive: true })
  const extracted = []
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    const rel = entry.name.split('/').slice(strip).join('/')
    if (!rel) continue
    const destPath = join(destDir, rel)
    mkdirSync(dirname(destPath), { recursive: true })
    const off = entry.localOffset
    if (buf.readUInt32LE(off) !== LOC_SIG) throw new Error(`${entry.name}: 本地头损坏`)
    const nameLen = buf.readUInt16LE(off + 26)
    const extraLen = buf.readUInt16LE(off + 28)
    const dataStart = off + 30 + nameLen + extraLen
    const data = buf.subarray(dataStart, dataStart + entry.compSize)
    const out = entry.method === 8 ? inflateRawSync(data) : data
    writeFileSync(destPath, out)
    extracted.push(rel)
    if (onEntry) onEntry(rel)
  }
  return extracted
}

/**
 * 解压 npm tgz。filter 返回 true 才写盘（用于先读元数据）。
 */
export function extractTarGz(tgzPath, destDir, { strip = 1, filter = null, onEntry = null } = {}) {
  const buf = gunzipSync(readFileSync(tgzPath))
  const entries = []
  let off = 0
  while (off + 512 <= buf.length) {
    const name = buf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/u, '')
    if (name === '') break
    const size = Number.parseInt(buf.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/u, '').trim(), 8) || 0
    const type = buf.subarray(off + 156, off + 157).toString('utf8')
    const dataStart = off + 512
    entries.push({ name, size, type, dataStart })
    off = dataStart + Math.ceil(size / 512) * 512
  }
  mkdirSync(destDir, { recursive: true })
  const extracted = []
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    if (entry.type !== '0' && entry.type !== '') continue
    const rel = entry.name.split('/').slice(strip).join('/')
    if (!rel) continue
    if (filter && !filter(rel)) continue
    const destPath = join(destDir, rel)
    mkdirSync(dirname(destPath), { recursive: true })
    writeFileSync(destPath, buf.subarray(entry.dataStart, entry.dataStart + entry.size))
    extracted.push(rel)
    if (onEntry) onEntry(rel)
  }
  return extracted
}
