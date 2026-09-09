/**
 * 版本管理：Harness(dsh) / llama.cpp / 内置 Node 三组件的
 * 当前版本、最新版本检查、更新（备份+staging 验证+替换）与回滚。
 */
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, ROOT, run, nodeExe, npmCli, backupDirs, logPath } from './core.mjs'
import { downloadTo } from './downloads.mjs'
import { fetchZipEntries, extractZip, extractTarGz } from './zip-utils.mjs'
import { stopDsh, stopLlm, dshStatus, llmStatus } from './services.mjs'
import { createWriteStream } from 'node:fs'

export const updateEvents = new EventEmitter()
const emit = (component, line, type = 'log') =>
  updateEvents.emit('event', { component, type, line: String(line).slice(0, 2000), ts: Date.now() })

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

async function latestLlamaRelease() {
  const releases = await jsonFetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8')
  const patterns = [
    /^llama-b\d+-bin-win-cuda-13\.\d+-x64\.zip$/,
    /^llama-b\d+-bin-win-cuda-\d+\.\d+-x64\.zip$/,
    /^llama-b\d+-bin-win-vulkan-x64\.zip$/,
    /^llama-b\d+-bin-win-cpu-x64\.zip$/,
  ]
  for (const pattern of patterns) {
    for (const release of releases) {
      for (const asset of release.assets ?? []) {
        if (pattern.test(asset.name)) {
          const url = asset.browser_download_url
          return {
            tag: release.tag_name,
            asset: asset.name,
            size: asset.size ?? null,
            url,
            mirrors: [`https://gh-proxy.com/${url}`, url],
          }
        }
      }
    }
  }
  throw new Error('未找到可用的 llama.cpp Windows 构建')
}

async function latestNodeVersion() {
  const index = await jsonFetch('https://nodejs.org/dist/index.json', 30000)
  const versions = index.map(e => e.version).filter(v => /^v24\./.test(v))
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return versions[versions.length - 1]
}

// ---------- 汇总 ----------

/** 解析 llama 构建号（如 b10819 → 10819），非 b 格式返回 NaN。 */
function buildNum(tag) {
  const m = String(tag ?? '').match(/^b(\d+)$/i)
  return m ? Number(m[1]) : NaN
}

/** 是否可更新：latest 语义上严格大于 current。 */
function hasNewer(current, latest) {
  if (!latest) return false
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

function swapWithBackup(dirName, stagingDir, backupName) {
  const target = join(ROOT, dirName)
  for (const old of backupDirs(ROOT).filter(n => n.startsWith(`${dirName === 'runtime' ? 'runtime' : dirName}-backup-`))) {
    rmSync(join(ROOT, old), { recursive: true, force: true })
  }
  if (existsSync(target)) renameSync(target, join(ROOT, backupName))
  renameSync(stagingDir, target)
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
  const current = currentHarnessVersion()
  emit('harness', `备份旧版本 ${current} 并替换……`)
  swapWithBackup('harness', staging, `harness-backup-${current}`)
  emit('harness', '更新完成', 'done')
  return { version }
}

// ---------- 更新：llama.cpp ----------

async function tryNlcFastPath(release, staging) {
  // 1) 下载 node-llama-cpp 平台包（npmmirror 高速）
  const meta = await jsonFetch('https://registry.npmmirror.com/@node-llama-cpp%2Fwin-x64-cuda')
  const version = meta['dist-tags']?.latest
  const tarball = meta.versions?.[version]?.dist?.tarball
  if (!version || !tarball) return false
  emit('llama', `尝试快速路径：node-llama-cpp@${version} 提供 CUDA DLL……`)
  const tgz = join(DIRS.logs, 'downloads', `nlc-win-x64-cuda-${version}.tgz`)
  await downloadTo(tarball, tgz, { label: 'nlc', onProgress: t => emit('llama', `下载平台包 ${Math.round(t.downloaded / 1e6)}MB${t.total ? `/${Math.round(t.total / 1e6)}MB` : ''}`) })
  // 2) 只提取构建元数据判断版本是否匹配
  extractTarGz(tgz, staging, {
    strip: 0,
    filter: rel => rel === 'package/bins/win-x64-cuda/_nlcBuildMetadata.json',
  })
  const metaPath = join(staging, 'package', 'bins', 'win-x64-cuda', '_nlcBuildMetadata.json')
  if (!existsSync(metaPath)) return false
  const build = JSON.parse(readFileSync(metaPath, 'utf8'))
  if (build.llamaCpp?.release !== release.tag) {
    emit('llama', `平台包构建 ${build.llamaCpp?.release} 与最新 ${release.tag} 不一致，改用整包下载`)
    return false
  }
  // 3) 提取 DLL 并分片补齐缺失文件
  extractTarGz(tgz, staging, {
    strip: 0,
    filter: rel => /^package\/bins\/win-x64-cuda\/[^/]+\.(dll|lib)$/i.test(rel),
  })
  const dllDir = join(staging, 'package', 'bins', 'win-x64-cuda')
  const { readdirSync } = await import('node:fs')
  for (const name of readdirSync(dllDir)) renameSync(join(dllDir, name), join(staging, name))
  emit('llama', '分片抓取 llama-server 可执行文件与缺失 DLL……')
  await fetchZipEntries(release.mirrors[0], staging, {
    existingDir: staging,
    wanted: base => base === 'llama-server.exe' || /\.dll$/i.test(base),
    onEntry: base => emit('llama', `获取 ${base}`),
  })
  return true
}

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
  emit('llama', `最新构建：${release.tag}（${release.asset}）`)
  const staging = join(ROOT, 'llm-update')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  let fast = false
  try {
    fast = await tryNlcFastPath(release, staging)
  } catch (error) {
    emit('llama', `快速路径失败（${error.message}），改用整包下载`)
  }
  if (!fast) {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    emit('llama', `整包获取 ${release.asset}（分片抓取，约 ${Math.round(release.size / 1e6)}MB，请耐心等待）……`)
    try {
      // 首选：Range 分片抓取全部条目（镜像支持 Range，实测可用）
      await fetchZipEntries(release.mirrors[0], staging, {
        existingDir: null,
        wanted: () => true,
        onEntry: base => emit('llama', `获取 ${base}`),
      })
    } catch (rangeError) {
      emit('llama', `分片抓取失败（${rangeError.message}），改用流式整包下载`)
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      const zip = join(DIRS.logs, 'downloads', release.asset)
      let lastError = null
      for (const url of release.mirrors) {
        try {
          await downloadTo(url, zip, { label: 'llama', onProgress: t => emit('llama', `下载 ${Math.round(t.downloaded / 1e6)}MB${t.total ? `/${Math.round(t.total / 1e6)}MB` : ''}`) })
          lastError = null
          break
        } catch (error) {
          lastError = error
          emit('llama', `源 ${url} 失败：${error.message}`)
        }
      }
      if (lastError) throw lastError
      emit('llama', '解压中……')
      extractZip(zip, staging, { onEntry: rel => emit('llama', `解压 ${rel}`) })
    }
  }
  const verify = run(join(staging, 'llama-server.exe'), ['--version'], { cwd: staging })
  if (!verify.ok) throw new Error(`llama-server 验证失败：${verify.stderr.slice(0, 200)}`)
  emit('llama', `验证通过：${verify.stderr.split(/\r?\n/)[0] ?? ''}`)
  writeFileSync(join(staging, 'BUILD_ID'), release.tag + '\n', 'ascii')
  const current = currentLlamaBuild()
  emit('llama', `备份旧构建 ${current} 并替换……`)
  swapWithBackup('llm', staging, `llm-backup-${current}`)
  emit('llama', '更新完成', 'done')
  return { version: release.tag }
}

// ---------- 更新：内置 Node ----------

async function updateNode() {
  const { version } = await latestNodeVersion()
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
  const current = currentNodeVersion()
  const runtimeDir = DIRS.runtimeNode
  const backupDir = join(ROOT, `runtime-backup-${current}`)
  for (const old of backupDirs(ROOT).filter(n => n.startsWith('runtime-backup-'))) {
    rmSync(join(ROOT, old), { recursive: true, force: true })
  }
  if (existsSync(runtimeDir)) renameSync(runtimeDir, backupDir)
  renameSync(staging, runtimeDir)
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
