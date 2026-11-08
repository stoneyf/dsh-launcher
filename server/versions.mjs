/**
 * 版本管理：Harness(dsh) / llama.cpp / 内置 Node 三组件的
 * 当前版本、最新版本检查、更新（备份+staging 验证+替换）与回滚。
 */
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, ROOT, run, nodeExe, npmCli, backupDirs, logPath, readConfig } from './core.mjs'
import { downloadTo, rankRoutes } from './downloads.mjs'
import { extractZip } from './zip-utils.mjs'
import { stopDsh, stopLlm, dshStatus, llmStatus } from './services.mjs'
import { createWriteStream } from 'node:fs'

export const updateEvents = new EventEmitter()
const emit = (component, line, type = 'log', extra = null) =>
  updateEvents.emit('event', { component, type, line: String(line).slice(0, 2000), ts: Date.now(), ...(extra ?? {}) })

const latestCache = {}

// ---------- 当前版本 ----------

function currentHarnessVersion() {
  try {
    return JSON.parse(readFileSync(join(DIRS.harness, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
  } catch { return '未安装' }
}

function currentLlamaBuild() {
  // 1) 更新流程写入的构建标记（权威）
  try {
    const marker = readFileSync(join(DIRS.llm, 'BUILD_ID'), 'utf8').trim()
    if (/^b\d+$/.test(marker)) return marker
  } catch { /* 无标记 */ }
  // 2) DLL 文件名中的构建号
  try {
    for (const name of readdirSync(DIRS.llm)) {
      const m = name.match(/\.b(\d+)\.dll$/i)
      if (m) return `b${m[1]}`
    }
  } catch { /* 目录不存在 */ }
  // 3) 可执行文件版本输出
  try {
    const r = run(join(DIRS.llm, 'llama-server.exe'), ['--version'])
    const m = r.stderr.match(/version:\s*\d+\s*\(([0-9a-f]+)\)/)
    if (m) return `commit ${m[1]}`
  } catch { /* 不可执行 */ }
  return '未安装'
}

function currentNodeVersion() {
  const r = run(nodeExe(), ['--version'])
  return r.ok ? r.stdout.trim() : '未安装'
}

// ---------- 最新版本查询 ----------

async function jsonFetch(url, timeoutMs = 25000) {
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'dsh-launcher', Accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
  throw lastError
}

/** 简易 semver 比较：返回 1 / -1 / 0。支持 prerelease。 */
export function compareVersions(a, b) {
  const parse = v => {
    const [core, pre = ''] = String(v).replace(/^v/, '').split('-')
    const nums = core.split('.').map(n => Number(n) || 0)
    while (nums.length < 3) nums.push(0)
    return { nums, pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] > right.nums[i] ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  const l = left.pre.split('.').map(p => (Number.isNaN(Number(p)) ? p : Number(p)))
  const r = right.pre.split('.').map(p => (Number.isNaN(Number(p)) ? p : Number(p)))
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    const lv = l[i] ?? (typeof r[i] === 'number' ? 0 : '')
    const rv = r[i] ?? (typeof l[i] === 'number' ? 0 : '')
    if (lv === rv) continue
    if (typeof lv === 'number' && typeof rv === 'number') return lv > rv ? 1 : -1
    return String(lv) > String(rv) ? 1 : -1
  }
  return 0
}

async function latestHarnessVersion() {
  const data = await jsonFetch('https://registry.npmmirror.com/@deepseek-ai%2Fdsh')
  const tags = data['dist-tags'] ?? {}
  // 取所有 tag 中 semver 最大的版本（避免 alpha tag 落后于实际发布）
  let best = null
  let bestTag = null
  for (const [tag, version] of Object.entries(tags)) {
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) continue
    if (!best || compareVersions(version, best) > 0) {
      best = version
      bestTag = tag
    }
  }
  if (!best) throw new Error('registry 没有可用版本')
  return { version: best, channel: bestTag }
}

// 2026-10-29 用户拍板：境外镜像兜底全删（ghproxy/gh-proxy/ghfast 都在境外，
// 实测直连也不如 GitHub 本身）。只留 GitHub 直连，走直连/代理测速后择快。
const LLAMA_ASSET_PATTERNS = [
  /^llama-b\d+-bin-win-cuda-13\.\d+-x64\.zip$/,
  /^llama-b\d+-bin-win-cuda-\d+\.\d+-x64\.zip$/,
  /^llama-b\d+-bin-win-vulkan-x64\.zip$/,
  /^llama-b\d+-bin-win-cpu-x64\.zip$/,
]

/** 从一个 release 的资产里挑出本机可用的 Windows 构建（CUDA → Vulkan → CPU 依次尝试）。
 *  @returns {{asset:string,size:number|null,url:string,mirrors:string[]}|null} */
function pickLlamaAsset(assets) {
  for (const pattern of LLAMA_ASSET_PATTERNS) {
    for (const asset of assets ?? []) {
      if (pattern.test(asset.name)) {
        const url = asset.browser_download_url
        return { asset: asset.name, size: asset.size ?? null, url, mirrors: [url] }
      }
    }
  }
  return null
}

async function latestLlamaRelease() {
  const releases = await jsonFetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8')
  for (const release of releases) {
    const hit = pickLlamaAsset(release.assets)
    if (hit) return { ...hit, tag: release.tag_name }
  }
  throw new Error('未找到可用的 llama.cpp Windows 构建')
}

async function latestNodeVersion() {
  const index = await jsonFetch('https://nodejs.org/dist/index.json', 30000)
  const versions = index.map(e => e.version).filter(v => /^v24\./.test(v))
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return versions[versions.length - 1]
}

// ---------- 远程历史版本（切换版本用：现下现装，不再依赖本地备份） ----------

const remoteCache = { at: 0, data: {} }
const REMOTE_TTL_MS = 10 * 60 * 1000

/** 列出某组件在远程可安装的历史版本（npm registry / GitHub Releases / nodejs.org）。
 *  @param component - harness | llama | node
 *  @param opts.refresh - 忽略 10 分钟缓存重新拉取
 *  @returns {Promise<Array<{version:string,asset?:string,size?:number|null,url?:string}>>} 新→旧 */
export async function remoteVersions(component, { refresh = false } = {}) {
  if (!refresh && remoteCache.data[component] && Date.now() - remoteCache.at < REMOTE_TTL_MS) {
    return remoteCache.data[component]
  }
  let data
  if (component === 'harness') {
    const meta = await jsonFetch('https://registry.npmmirror.com/@deepseek-ai%2Fdsh')
    data = Object.keys(meta.versions ?? {})
      .filter(v => /^\d+\.\d+\.\d+/.test(v))
      .sort((a, b) => compareVersions(b.replace(/^v/, ''), a.replace(/^v/, '')))
      .slice(0, 40)
      .map(version => ({ version }))
  } else if (component === 'llama') {
    const releases = await jsonFetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30')
    data = []
    for (const release of releases) {
      const hit = pickLlamaAsset(release.assets)
      if (hit) data.push({ version: release.tag_name, asset: hit.asset, size: hit.size, url: hit.url })
    }
  } else if (component === 'node') {
    // nodejs.org 在国内经常超时（index.json 1MB 左右），失败就换 npmmirror 的 node 镜像
    const sources = ['https://nodejs.org/dist/index.json', 'https://npmmirror.com/mirrors/node/index.json']
    let index = null
    let lastError = null
    for (const url of sources) {
      try { index = await jsonFetch(url, 45000); break } catch (error) { lastError = error }
    }
    if (!index) throw lastError ?? new Error('取不到 Node 版本索引')
    data = index.map(e => e.version)
      .filter(v => /^v24\./.test(v))
      .sort((a, b) => compareVersions(b.replace(/^v/, ''), a.replace(/^v/, '')))
      .slice(0, 40)
      .map(version => ({ version }))
  } else {
    throw new Error(`未知组件：${component}`)
  }
  remoteCache.data[component] = data
  remoteCache.at = Date.now()
  return data
}

// ---------- 汇总 ----------

/** 解析 llama 构建号（如 b10819 → 10819），非 b 格式返回 NaN。 */
function buildNum(tag) {
  const m = String(tag ?? '').match(/^b(\d+)$/i)
  return m ? Number(m[1]) : NaN
}

/** 是否可更新：latest 语义上严格大于 current；未检查过（无 latest）返回 null（未知，别当成"已是最新"）。 */
function hasNewer(current, latest) {
  if (!latest) return null
  const curNum = buildNum(current)
  const latNum = buildNum(latest)
  if (!Number.isNaN(curNum) && !Number.isNaN(latNum)) return latNum > curNum
  return compareVersions(latest, current) > 0
}

export function versionSummary() {
  const harness = {
    current: currentHarnessVersion(),
    latest: latestCache.harness?.version ?? null,
    channel: latestCache.harness?.channel ?? null,
    checkedAt: latestCache.harness?.checkedAt ?? null,
    backups: backupDirs(ROOT).filter(n => n.startsWith('harness-backup-')),
  }
  const llama = {
    current: currentLlamaBuild(),
    latest: latestCache.llama?.tag ?? null,
    checkedAt: latestCache.llama?.checkedAt ?? null,
    backups: backupDirs(ROOT).filter(n => n.startsWith('llm-backup-')),
  }
  const node = {
    current: currentNodeVersion(),
    latest: latestCache.node?.version ?? null,
    checkedAt: latestCache.node?.checkedAt ?? null,
    backups: backupDirs(ROOT).filter(n => n.startsWith('runtime-backup-')),
  }
  return {
    harness: { ...harness, updateAvailable: hasNewer(harness.current, harness.latest) },
    llama: { ...llama, updateAvailable: hasNewer(llama.current, llama.latest) },
    node: { ...node, updateAvailable: hasNewer(node.current, node.latest) },
  }
}

export async function checkUpdate(component) {
  const now = Date.now()
  if (component === 'harness') {
    const latest = await latestHarnessVersion()
    latestCache.harness = { ...latest, checkedAt: now }
    return { current: currentHarnessVersion(), ...latest }
  }
  if (component === 'llama') {
    const latest = await latestLlamaRelease()
    latestCache.llama = { ...latest, checkedAt: now }
    return { current: currentLlamaBuild(), latest: latest.tag }
  }
  if (component === 'node') {
    const latest = { version: await latestNodeVersion() }
    latestCache.node = { ...latest, checkedAt: now }
    return { current: currentNodeVersion(), ...latest }
  }
  if (component === 'launcher') {
    const { checkLauncherUpdate } = await import('./launcher-update.mjs')
    return await checkLauncherUpdate()
  }
  throw new Error(`未知组件：${component}`)
}

// ---------- 通用备份/替换 ----------

/** 用 staging 替换正式目录。4.5.11 起**不再保留本地备份**（版本切换改为从 GitHub 现下现装），
 *  被替换掉的旧目录先改名再删除；删除失败（比如 exe 被占用）就留着，不影响替换结果。 */
function swapNoBackup(dirName, stagingDir) {
  const target = join(ROOT, dirName)
  const old = existsSync(target) ? join(ROOT, `${dirName}-rollback-old-${Date.now()}`) : null
  if (old) renameSync(target, old)
  try {
    renameSync(stagingDir, target)
  } catch (error) {
    if (old) renameSync(old, target)
    throw error
  }
  if (old) {
    try { rmSync(old, { recursive: true, force: true }) } catch { /* 被占用就先留着 */ }
  }
}

// ---------- 更新：Harness ----------

async function npmInstallStaging(staging, version) {
  const npm = npmCli()
  if (!npm) throw new Error('未找到内置 npm（runtime\\node\\node_modules\\npm）。')
  writeFileSync(join(staging, 'package.json'), JSON.stringify({
    name: 'dsh-launcher-harness',
    version: '1.0.0',
    private: true,
    dependencies: { '@deepseek-ai/dsh': version },
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(staging, '.npmrc'), [
    'registry=https://registry.npmmirror.com/',
    'audit=false',
    'fund=false',
    'package-lock=false',
  ].join('\r\n') + '\r\n', 'ascii')
  const { spawn } = await import('node:child_process')
  const proc = spawn(nodeExe(), [npm, 'install', '--no-audit', '--no-fund'], {
    cwd: staging,
    env: { ...process.env, NPM_CONFIG_CACHE: DIRS.npmCache },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const sink = createWriteStream(logPath('update-harness.log'), { flags: 'a' })
  const tap = chunk => {
    sink.write(chunk)
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) emit('harness', line)
    }
  }
  proc.stdout.on('data', tap)
  proc.stderr.on('data', tap)
  const code = await new Promise(resolve => proc.on('exit', resolve))
  sink.end()
  if (code !== 0) throw new Error(`npm install 失败（退出码 ${code}）`)
  const bin = join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) throw new Error('安装完成但未找到 dsh 入口')
  const verify = run(nodeExe(), [bin, '--version'])
  if (!verify.ok) throw new Error(`dsh 版本验证失败：${verify.stderr.slice(0, 200)}`)
  emit('harness', `安装完成：${verify.stdout.trim()}`)
}

async function updateHarness() {
  const { version, channel } = await latestHarnessVersion()
  if (compareVersions(version, currentHarnessVersion()) <= 0) {
    const cur = currentHarnessVersion()
    emit('harness', `当前 ${cur} 已是最新，无需更新`, 'done')
    return { alreadyLatest: true, version: cur }
  }
  if (dshStatus().running) {
    emit('harness', '正在停止 Harness……')
    await stopDsh()
  }
  emit('harness', `最新版本：${version}（${channel} 通道），开始安装……`)
  const staging = join(ROOT, 'harness-update')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  await npmInstallStaging(staging, version)
  emit('harness', '替换旧版本……')
  swapNoBackup('harness', staging)
  emit('harness', '更新完成', 'done')
  return { version }
}

// ---------- 下载 llama.cpp 构建包（更新与版本切换共用） ----------

/** 下载并校验 llama.cpp 的 Windows 构建 zip。
 *  整包流式下载（curl）：进度、断点续传、自动重试、按配置走 DOWNLOAD_PROXY；
 *  直连/代理先各拉 2MB 测速，快的优先，失败换另一条线路。
 *  @param release - {tag, asset, size, url, mirrors}
 *  @returns {Promise<string>} 本地 zip 路径 */
async function downloadLlamaZip(release) {
  mkdirSync(join(DIRS.logs, 'downloads'), { recursive: true })
  const zip = join(DIRS.logs, 'downloads', release.asset)
  const mb = n => Math.round(n / 1e6)
  // 镜像有时不返错误码、而是把 404 页面当正文交付（curl 不加 -f 会当成成功），
  // 所以下载完必须校验：大小对得上、且真的是 zip（头两字节 PK）。
  const zipLooksValid = () => {
    try {
      const size = statSync(zip).size
      if (size < 22) return false
      if (release.size && size !== release.size) return false
      const fd = openSync(zip, 'r')
      const head = Buffer.alloc(2)
      readSync(fd, head, 0, 2, 0)
      closeSync(fd)
      return head.toString('latin1') === 'PK'
    } catch { return false }
  }
  let lastError = null
  let lastShown = -1
  // 用户要求（2026-10-29）：境外镜像兜底已删，只留 GitHub 直连。
  // 但同一 URL 有「直连」和「代理」两条路——先各拉 2MB 测速，快的优先，
  // 失败再换另一条重试（断点续传保留 .part）。
  for (const url of release.mirrors) {
    const host = (() => { try { return new URL(url).host } catch { return url } })()
    let routes = []
    try {
      routes = await rankRoutes(url, readConfig())
      const desc = routes.map(r => `${r.proxy ? '代理' : '直连'} ${r.speed ? (r.speed / 1024).toFixed(0) + 'KB/s' : '测速失败'}`).join(' / ')
      emit('llama', `测速：${desc}（选择${routes[0].proxy ? '代理' : '直连'}）`)
    } catch {
      routes = [{ proxy: '', speed: 0 }]
    }
    for (const route of routes) {
      const routeName = route.proxy ? '代理' : '直连'
      try {
        await downloadTo(url, zip, {
          label: 'llama',
          proxy: route.proxy,
          onProgress: t => {
            if (t.state !== 'running') return
            if (t.total) {
              const pct = Math.floor((t.downloaded / t.total) * 100)
              if (pct === lastShown) return
              lastShown = pct
              emit('llama', `下载 ${release.asset} ${mb(t.downloaded)}/${mb(t.total)}MB（${pct}%）· ${routeName} · ${host}`, 'progress', { pct })
            } else if (mb(t.downloaded) !== lastShown) {
              lastShown = mb(t.downloaded)
              emit('llama', `下载 ${release.asset} ${mb(t.downloaded)}MB · ${routeName} · ${host}`)
            }
          },
        })
        if (!zipLooksValid()) {
          rmSync(zip, { force: true })
          rmSync(`${zip}.part`, { force: true })
          throw new Error('下载到的不是有效 zip（可能返回了错误页）')
        }
        lastError = null
        break
      } catch (error) {
        lastError = error
        lastShown = -1
        // 网络中断不删 .part：换另一条线路（或下次点更新）可以接着续传；只有内容不对才在上面清掉
        emit('llama', `${routeName}下载失败：${error.message}（保留断点，换另一条线路）`)
      }
    }
    if (!lastError) break
  }
  if (lastError) throw new Error(`下载 ${release.asset} 失败：${lastError.message}`)
  return zip
}

// ---------- 更新：llama.cpp ----------

async function updateLlama() {
  const release = await latestLlamaRelease()
  const curBuild = currentLlamaBuild()
  if (!(buildNum(release.tag) > buildNum(curBuild))) {
    emit('llama', `当前 ${curBuild} 已是最新，无需更新`, 'done')
    return { alreadyLatest: true, version: release.tag }
  }
  if ((await llmStatus()).running) {
    emit('llama', '正在停止本地大模型……')
    await stopLlm()
  }
  const sizeText = release.size ? `，约 ${Math.round(release.size / 1e6)}MB` : ''
  emit('llama', `最新构建：${release.tag}（${release.asset}${sizeText}）`)

  const staging = join(ROOT, 'llm-update')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  // 整包流式下载（curl）：每秒刷新进度、支持断点续传、自动重试，并按配置走 DOWNLOAD_PROXY。
  // 旧逻辑是「node fetch 按 1MB Range 分片抓取」——本机实测只有 70~85KB/s，且要抓完整个文件才输出一行，
  // 表现为「卡在安装包下载、界面完全没有进度」，已弃用。
  const zip = await downloadLlamaZip(release)

  emit('llama', '解压中……')
  extractZip(zip, staging, { onEntry: rel => emit('llama', `解压 ${rel}`) })
  const verify = run(join(staging, 'llama-server.exe'), ['--version'], { cwd: staging })
  if (!verify.ok) throw new Error(`llama-server 验证失败：${verify.stderr.slice(0, 200)}`)
  emit('llama', `验证通过：${verify.stderr.split(/\r?\n/)[0] ?? ''}`)
  writeFileSync(join(staging, 'BUILD_ID'), release.tag + '\n', 'ascii')
  emit('llama', '替换旧构建……')
  swapNoBackup('llm', staging)
  emit('llama', '更新完成', 'done')
  return { version: release.tag }
}

// ---------- 更新：内置 Node ----------

async function updateNode() {
  // latestNodeVersion() 返回的是版本字符串（如 v24.22.2），不是对象——
  // 旧代码写成 `const { version } = await latestNodeVersion()`，解构字符串得到 undefined，
  // compareVersions(undefined, cur) === 0，于是每次都误报「已是最新」，node 永远不更新。
  const version = await latestNodeVersion()
  if (!version) throw new Error('nodejs.org 版本索引里没有 v24.x 版本')
  if (compareVersions(version, currentNodeVersion()) <= 0) {
    const cur = currentNodeVersion()
    emit('node', `当前 ${cur} 已是最新，无需更新`, 'done')
    return { alreadyLatest: true, version: cur }
  }
  emit('node', `最新版本：${version}`)
  const staging = join(ROOT, 'runtime-update')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const zip = join(DIRS.logs, 'downloads', `node-${version}-win-x64.zip`)
  emit('node', `下载 ${zip}……`)
  await downloadTo(`https://nodejs.org/dist/${version}/node-${version}-win-x64.zip`, zip, {
    label: 'node',
    onProgress: t => emit('node', `下载 ${Math.round(t.downloaded / 1e6)}MB${t.total ? `/${Math.round(t.total / 1e6)}MB` : ''}`),
  })
  extractZip(zip, staging, { strip: 1 })
  const verify = run(join(staging, 'node.exe'), ['--version'], { cwd: staging })
  if (!verify.ok || !verify.stdout.trim()) throw new Error('解压后 node.exe 验证失败')
  emit('node', `验证通过：${verify.stdout.trim()}`)
  const runtimeDir = DIRS.runtimeNode
  const oldRuntime = existsSync(runtimeDir) ? join(ROOT, `runtime-rollback-old-${Date.now()}`) : null
  if (oldRuntime) renameSync(runtimeDir, oldRuntime)
  renameSync(staging, runtimeDir)
  if (oldRuntime) {
    try { rmSync(oldRuntime, { recursive: true, force: true }) } catch { /* 被占用就先留着 */ }
  }
  emit('node', '更新完成', 'done')
  return { version }
}

// ---------- 回滚 ----------

function rollbackDir(dirName, backupPrefix) {
  const backups = backupDirs(ROOT).filter(n => n.startsWith(backupPrefix))
  if (backups.length === 0) throw new Error('没有可回滚的备份')
  const backup = backups[backups.length - 1]
  const target = join(ROOT, dirName)
  if (existsSync(target)) renameSync(target, join(ROOT, `${dirName}-rollback-old-${Date.now()}`))
  renameSync(join(ROOT, backup), target)
  return backup
}

export async function updateComponent(component) {
  if (updateRunning) throw new Error('已有更新任务进行中，请稍候。')
  updateRunning = true
  try {
    if (component === 'harness') return await updateHarness()
    if (component === 'llama') return await updateLlama()
    if (component === 'node') return await updateNode()
    if (component === 'launcher') {
      const { updateLauncher } = await import('./launcher-update.mjs')
      return await updateLauncher()
    }
    throw new Error(`未知组件：${component}`)
  } finally {
    updateRunning = false
  }
}

let updateRunning = false
export function isUpdateRunning() {
  return updateRunning
}

export async function rollbackComponent(component) {
  if (component === 'harness') {
    const backup = rollbackDir('harness', 'harness-backup-')
    return { restored: backup }
  }
  if (component === 'llama') {
    const backup = rollbackDir('llm', 'llm-backup-')
    return { restored: backup }
  }
  if (component === 'node') {
    const backups = backupDirs(ROOT).filter(n => n.startsWith('runtime-backup-'))
    if (backups.length === 0) throw new Error('没有可回滚的备份')
    const backup = backups[backups.length - 1]
    const runtimeDir = DIRS.runtimeNode
    if (existsSync(runtimeDir)) renameSync(runtimeDir, join(ROOT, `runtime-rollback-old-${Date.now()}`))
    renameSync(join(ROOT, backup), runtimeDir)
    return { restored: backup }
  }
  if (component === 'launcher') {
    const { rollbackLauncher } = await import('./launcher-update.mjs')
    return await rollbackLauncher()
  }
  throw new Error(`未知组件：${component}`)
}

// ---------- 版本切换（在已安装的备份版本间切换） ----------

const COMPONENT_NOTES = {
  harness: { label: 'dsh 版本说明', url: 'https://www.npmjs.com/package/@deepseek-ai/dsh' },
  llama: { label: 'llama.cpp 版本说明', url: 'https://github.com/ggml-org/llama.cpp/releases' },
  node: { label: 'Node.js 版本说明', url: 'https://nodejs.org/en/blog/release' },
}

/** 某组件的版本说明入口（release 页 / 包页）。 */
export function componentNotes(component) {
  return COMPONENT_NOTES[component] ?? null
}

/** 列出某组件可切换的版本：当前 + 本地备份 + 远程历史版本。
 *  远程版本（npm / GitHub Releases / nodejs.org）选了就现下现装，见 switchComponentVersion。
 *  @returns {Promise<{current:string|null,options:Array,remoteError:string|null}>} */
export async function listComponentVersions(component) {
  const s = versionSummary()
  let prefix = '', current = null
  if (component === 'harness') { prefix = 'harness-backup-'; current = s.harness.current }
  else if (component === 'llama') { prefix = 'llm-backup-'; current = s.llama.current }
  else if (component === 'node') { prefix = 'runtime-backup-'; current = s.node.current }
  else throw new Error(`未知组件：${component}`)
  const seen = new Set()
  const options = []
  if (current && current !== '未安装') {
    options.push({ version: current, isCurrent: true })
    seen.add(current)
  }
  for (const name of backupDirs(ROOT).filter(n => n.startsWith(prefix))) {
    const version = name.slice(prefix.length)
    if (seen.has(version)) continue
    seen.add(version)
    options.push({ version, isCurrent: false, local: true })
  }
  let remoteError = null
  let latest = null
  try {
    const remote = await remoteVersions(component)
    latest = remote[0]?.version ?? null
    for (const item of remote) {
      const version = String(item.version ?? '').trim()
      if (!version || seen.has(version)) continue
      seen.add(version)
      options.push({ version, isCurrent: false, remote: true })
    }
  } catch (error) {
    remoteError = error?.message ?? String(error)
  }
  return { current, options, latest, remoteError }
}

function switchToBackup(dirName, backupName) {
  const backupPath = join(ROOT, backupName)
  if (!existsSync(backupPath)) throw new Error(`找不到该版本的备份：${backupName}`)
  const target = join(ROOT, dirName)
  if (existsSync(target)) renameSync(target, join(ROOT, `${dirName}-rollback-old-${Date.now()}`))
  renameSync(backupPath, target)
  return backupName
}

/** 切换到某组件的指定版本：本地有该版本的备份就直接换，没有就从远程下载安装。
 *  4.5.11 起不再依赖本地备份——维护页「切换版本」下拉里 GitHub / npm / nodejs.org 的历史版本都能选。
 *  @returns {Promise<{restored:string,version?:string}>} */
export async function switchComponentVersion(component, version) {
  const v = String(version ?? '').trim()
  if (!v) throw new Error('未指定版本')
  const localName = component === 'harness' ? `harness-backup-${v}`
    : component === 'llama' ? `llm-backup-${v}`
    : component === 'node' ? `runtime-backup-${v}`
    : null
  if (!localName) throw new Error(`该组件不支持版本切换：${component}`)
  if (existsSync(join(ROOT, localName))) {
    if (component === 'harness') {
      if (dshStatus().running) await stopDsh()
      return { restored: switchToBackup('harness', localName) }
    }
    if (component === 'llama') {
      if ((await llmStatus()).running) await stopLlm()
      return { restored: switchToBackup('llm', localName) }
    }
    const runtimeDir = DIRS.runtimeNode
    if (existsSync(runtimeDir)) renameSync(runtimeDir, join(ROOT, `runtime-rollback-old-${Date.now()}`))
    renameSync(join(ROOT, localName), runtimeDir)
    return { restored: localName }
  }
  return await installRemoteVersion(component, v)
}

/** 从远程下载并安装指定版本（不再保留旧版备份；失败时正式目录保持原样）。 */
async function installRemoteVersion(component, version) {
  if (updateRunning) throw new Error('已有更新任务进行中，请稍候。')
  updateRunning = true
  try {
    if (component === 'harness') {
      if (version === currentHarnessVersion()) throw new Error('已经是当前版本')
      if (dshStatus().running) { emit('harness', '正在停止 Harness……'); await stopDsh() }
      emit('harness', `从 npm 安装 ${version}……`)
      const staging = join(ROOT, 'harness-update')
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      await npmInstallStaging(staging, version)
      emit('harness', '替换旧版本……')
      swapNoBackup('harness', staging)
      emit('harness', `已切换到 ${version}，启动 Harness 生效`, 'done')
      return { restored: version, version }
    }
    if (component === 'llama') {
      if (version === currentLlamaBuild()) throw new Error('已经是当前版本')
      const hit = (await remoteVersions('llama')).find(x => x.version === version)
      if (!hit) throw new Error(`GitHub 上找不到 ${version} 的 Windows 构建`)
      if ((await llmStatus()).running) { emit('llama', '正在停止本地大模型……'); await stopLlm() }
      emit('llama', `下载 ${version}（${hit.asset}）……`)
      const zip = await downloadLlamaZip({ tag: version, asset: hit.asset, size: hit.size ?? null, url: hit.url, mirrors: [hit.url] })
      const staging = join(ROOT, 'llm-update')
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      emit('llama', '解压中……')
      extractZip(zip, staging, { onEntry: rel => emit('llama', `解压 ${rel}`) })
      const verify = run(join(staging, 'llama-server.exe'), ['--version'], { cwd: staging })
      if (!verify.ok) throw new Error(`llama-server 验证失败：${verify.stderr.slice(0, 200)}`)
      writeFileSync(join(staging, 'BUILD_ID'), version + '\n', 'ascii')
      emit('llama', '替换旧构建……')
      swapNoBackup('llm', staging)
      emit('llama', `已切换到 ${version}`, 'done')
      return { restored: version, version }
    }
    if (component === 'node') {
      if (version === currentNodeVersion()) throw new Error('已经是当前版本')
      emit('node', `下载 ${version}……`)
      const staging = join(ROOT, 'runtime-update')
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      const zip = join(DIRS.logs, 'downloads', `node-${version}-win-x64.zip`)
      mkdirSync(join(DIRS.logs, 'downloads'), { recursive: true })
      await downloadTo(`https://nodejs.org/dist/${version}/node-${version}-win-x64.zip`, zip, {
        label: 'node',
        onProgress: t => emit('node', `下载 ${Math.round(t.downloaded / 1e6)}MB${t.total ? `/${Math.round(t.total / 1e6)}MB` : ''}`),
      })
      extractZip(zip, staging, { strip: 1 })
      const verify = run(join(staging, 'node.exe'), ['--version'], { cwd: staging })
      if (!verify.ok || !verify.stdout.trim()) throw new Error('解压后 node.exe 验证失败')
      const runtimeDir = DIRS.runtimeNode
      const oldRuntime = existsSync(runtimeDir) ? join(ROOT, `runtime-rollback-old-${Date.now()}`) : null
      if (oldRuntime) renameSync(runtimeDir, oldRuntime)
      renameSync(staging, runtimeDir)
      if (oldRuntime) { try { rmSync(oldRuntime, { recursive: true, force: true }) } catch { /* 被占用先留着 */ } }
      emit('node', `已切换到 ${version}`, 'done')
      return { restored: version, version }
    }
    throw new Error(`该组件不支持版本切换：${component}`)
  } finally {
    updateRunning = false
  }
}
