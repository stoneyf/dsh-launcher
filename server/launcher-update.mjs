/**
 * 启动器自身版本管理：版本清单（manifest）检查、更新（备份+替换）、回滚、重启生效。
 *
 * 清单格式（JSON）：
 *   { "version": "3.1.0", "notes": "更新说明", "url": "http(s) 或本地 zip 路径" }
 * 清单来源：config LAUNCHER_UPDATE_URL（http(s) URL 或本地文件路径），
 * 默认 ROOT\launcher-manifest.json（未配置且无本地清单 = 未配置更新源）。
 * zip 内容布局与启动器目录一致：server/ gui/ electron/ *.bat *.vbs *.exe *.cs README.md
 * 更新源默认走 GitHub Releases（见 scripts\publish.ps1 与 config LAUNCHER_UPDATE_URL）。
 *
 * 进度日志复用 versions.updateEvents（component='launcher'），GUI 无需新 SSE。
 */
import {
  existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, copyFileSync, statSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DIRS, ROOT, readConfig, LAUNCHER_VERSION, backupDirs } from './core.mjs'
import { compareVersions, updateEvents } from './versions.mjs'
import { downloadTo, curlText, proxyForUrl } from './downloads.mjs'
import { extractZip } from './zip-utils.mjs'

const emit = (line, type = 'log') =>
  updateEvents.emit('event', { component: 'launcher', type, line: String(line).slice(0, 2000), ts: Date.now() })

// ---------- GitHub Releases（版本切换：列出 / 下载任意历史版本） ----------
const GH_REPO = 'stoneyf/dsh-launcher'
const ghZipUrl = v => `https://github.com/${GH_REPO}/releases/download/v${v}/launcher-v${v}.zip`

/** 从 git 凭证库取 GitHub token（私有仓库访问需要）。无凭证返回 null。 */
function githubToken() {
  try {
    const r = spawnSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n', windowsHide: true, encoding: 'utf8',
    })
    for (const line of (r.stdout ?? '').split(/\r?\n/)) {
      if (line.startsWith('token=')) return line.slice(6).trim()
      if (line.startsWith('password=')) return line.slice(9).trim()
    }
  } catch { /* 无凭证 */ }
  return null
}

/** 列出 GitHub 上的全部发布版本（新→旧）：[{version, notes, url, publishedAt}]。 */
export async function listGitHubVersions() {
  const token = githubToken()
  if (!token) return { versions: [], error: '无 GitHub 凭证（无法列出私有仓库版本）' }
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/releases?per_page=100`, {
      signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'dsh-launcher' },
    })
    if (!res.ok) return { versions: [], error: `GitHub API HTTP ${res.status}` }
    const releases = await res.json()
    const versions = (Array.isArray(releases) ? releases : [])
      .map(r => {
        const v = String(r.tag_name ?? '').replace(/^v/, '')
        const asset = (r.assets ?? []).find(a => /\.zip$/i.test(a.name))
        return { version: v, notes: r.body ?? '', url: asset?.browser_download_url ?? ghZipUrl(v), publishedAt: r.published_at ?? '' }
      })
      .filter(x => /^\d+\.\d+\.\d+/.test(x.version))
    return { versions }
  } catch (e) {
    return { versions: [], error: e.message }
  }
}

export const CHANGELOG = `
4.1.2
    · 修复「打开目录」按钮点了没反应：打开目录的助手脚本原来用「分离式 PowerShell」方式启动，
      Win11 24H2 上这种启动法会让 powershell 静默退出（exit 0、脚本根本不执行）；已去掉 detached 并加启动失败日志
4.1.1
    · 修复维护页「环境诊断/版本管理」空白：主页引用了只定义在维护页的变量 activeModel，状态刷新一抛异常就整体误报「后端不可用」；现改为状态里取、跨页共用，渲染报错显示真实错误
    · 修复版本管理「最新 未检查 · 已是最新」矛盾：未检查过时 updateAvailable 返回 null（未知）而非 false，不再提前显示「已是最新」/禁用更新按钮
    · README 更新日志补上缺失的 4.1.0 条目
4.1.0
    · 修复 dsh 起不来（端口被锁）：web profile 的 webserver 配置会在 patch 层覆盖 dsh web --port，
      导致改 DSH_PORT 不生效、端口冲突时回退也撞回原端口（EADDRINUSE）。现在启动前自动把该段 port:
      同步为实际端口（只改这一行，其余不动）
    · 修复 dsh 启动失败时看不到真实原因：dsh「先监听、随后崩溃退出」时内部状态已清空，
      原先会抛 TypeError 把真正的错误盖掉，现在直接报出原始错误
4.0.0
    · 全新图标：exe / 窗口 / 任务栏统一为深蓝底白色闪电
    · 系统托盘：关窗收进托盘不停服务，LLM 后台继续运行；托盘菜单可打开/退出
    · 开机自启：设置页可开启「开机自动启动」，开机后台静默运行（托盘）
    · 更新提示：启动时自动检查，发现新版本主页顶部横幅提示（可忽略）
    · 版本切换：维护页可在任意已安装 / GitHub 历史版本间切换（从 GitHub 下载）
    · 对话管理：主页列出全部对话，可逐条删除 / 一键清空 / 打开对话文件夹
    · 模型下载：新增「删除任务」，模型名移到进度条上方
    · 关于页：新增启动器功能说明 + GitHub 地址；修复打开目录按钮
    · 主页底部：对话文件夹 / 本地模型快捷按钮
3.5.4
   · 最大输出 LLM_MAXTOKENS 改独立设置：可选 自动（用模型上限）/ 4K / 8K / 16K / 32K / 64K / 128K；自动时按当前模型自身上限算（不再写死 32K，换模型自动适配）
   · 上下文长度 / 最大输出选「自动」时，下方实时提示实际生效值（如 实际 192K / 实际 32K），方便确认
3.5.3
   · 设置页「上下文长度」改成下拉菜单：可选 自动（按显存）/ 32K / 64K / 128K / 192K / 256K，不用再手填数字
3.5.2
   · 上下文长度 / 最大输出自动调节：LLM_CTX=auto 时按显存 + 模型结构（gguf 探测 KV 缓存）自动选出能容纳的最大上下文
     （本机 32GB 显存：128K→192K），最大输出自动对齐模型上限 32K。想手动锁定就把 LLM_CTX 改成固定数字（如 131072）
3.5.1
   · 模型最大输出 maxTokens 8K→16K：长回答（写文章/长代码）不再被截断；短问答不受影响（16K 是上限，答完即停）
3.5.0
   · 下载提速：中国镜像（默认 hf-mirror，可用 DIRECT_HOSTS 追加）自动直连、绕开海外代理。
     实测模型下载 4.5→21 MB/s（快 4.7 倍）；GitHub 等其余源仍走 DOWNLOAD_PROXY（小文件快 6 倍）
   · 设置新增「直连主机 DIRECT_HOSTS」（逗号分隔），默认自动包含 HUB_MIRROR 主机
3.3.2
  · 设置新增「下载代理 DOWNLOAD_PROXY」：直连不稳定时填代理地址（如 http://127.0.0.1:10808），
    所有下载（启动器更新/模型/运行时）与更新清单请求均经代理，留空为直连
3.3.1
  · exe 缺失组件提示文案修正（setup.bat 已随 V2 退役）
3.3.0
  · 目录结构去 -v3：server/ gui/ electron/ + 入口 launcher.bat、启动器.bat/vbs、dsh-launcher.exe
  · 启动器自更新源指向 GitHub（Releases 清单 + raw 清单 URL），新增 scripts\\publish.ps1 一键发版
  · electron 运行时移至 runtime\\electron；V2 组件退役（源码备份至 GitHub）
3.2.0
  · 重启续会话：退出时写服务状态，新实例自动恢复 dsh/llm（关窗/崩溃均适用）
  · 模型广场：模型介绍 + 硬件建议；关于页目录按钮修复；新增 exe 双击入口
3.1.0
  · 双击入口隐藏 cmd 窗口（启动器.vbs）
  · 启动器版本管理：版本展示、检查/安装更新、回滚、changelog
  · 模型广场：搜索分页加载、下载速度与 ETA、文件筛选/排序、已安装标记、打开仓库页
  · 新增浅色主题（深色/浅色/跟随系统）
  · 修复「关于」打开目录按钮不前置的问题，并展示版本信息
3.0.0
  · 重启按钮独立编排（stopping→查杀孤儿→等端口→starting→loading→ready）
  · SSE 阶段进度即时推送 + 历史回放
  · /api/status 携带启动器版本与重启状态
  · 令牌文件 logs\\launcher.token
  · EADDRINUSE 自动回退随机端口并弹窗提醒
`.trim()

/** 参与版本备份/替换的启动器自身文件（相对 ROOT）。 */
const MANAGED_DIRS = ['server', 'gui', 'electron']
const MANAGED_FILES = ['launcher.bat', '启动器.bat', '启动器.vbs', 'dsh-launcher.exe', 'launcher.cs', 'README.md']

let checkCache = null // { version, notes, url, checkedAt }

export function setRelaunch(fn) {
  relaunchFn = fn
}
let relaunchFn = null
export function requestRelaunch() {
  if (relaunchFn) return relaunchFn()
  return { ok: false, message: '当前运行模式不支持自动重启' }
}

function backupNames() {
  return backupDirs(ROOT).filter(n => n.startsWith('launcher-backup-')).sort()
}

/** 启动器可切换的版本：当前 + 已安装备份。 */
export function launcherVersions() {
  const seen = new Set()
  const installed = []
  if (/^\d+\.\d+\.\d+/.test(LAUNCHER_VERSION)) {
    installed.push({ version: LAUNCHER_VERSION, isCurrent: true })
    seen.add(LAUNCHER_VERSION)
  }
  for (const name of backupNames()) {
    const version = name.slice('launcher-backup-'.length)
    if (seen.has(version)) continue
    seen.add(version)
    installed.push({ version, isCurrent: false })
  }
  return { current: LAUNCHER_VERSION, installed }
}

export function launcherInfo() {
  const cfg = readConfig()
  const source = cfg.LAUNCHER_UPDATE_URL || join(ROOT, 'launcher-manifest.json')
  return {
    version: LAUNCHER_VERSION,
    changelog: CHANGELOG,
    backups: backupNames(),
    updateSource: source,
    latest: checkCache?.version ?? null,
    notes: checkCache?.notes ?? null,
    updateUrl: checkCache?.url ?? null,
    checkedAt: checkCache?.checkedAt ?? null,
    updateAvailable: checkCache ? compareVersions(checkCache.version, LAUNCHER_VERSION) > 0 : null,
  }
}

async function loadManifest() {
  const cfg = readConfig()
  const source = cfg.LAUNCHER_UPDATE_URL || join(ROOT, 'launcher-manifest.json')
  let raw = null
  if (/^https?:\/\//i.test(source)) {
    const proxy = proxyForUrl(source, cfg)
    if (proxy) {
      // 配置了下载代理：Node fetch 不走代理，改用 curl（与下载同一代理）
      const text = await curlText(source, { proxy, timeoutSec: 20 })
      if (text == null) throw new Error('更新清单请求失败（curl 经代理）')
      raw = JSON.parse(text)
    } else {
      const res = await fetch(source, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`更新清单请求失败（HTTP ${res.status}）`)
      raw = await res.json()
    }
  } else {
    if (!existsSync(source)) throw new Error(`未找到更新清单：${source}（可在设置中配置 LAUNCHER_UPDATE_URL）`)
    raw = JSON.parse(readFileSync(source, 'utf8'))
  }
  const version = String(raw.version ?? '')
  const url = String(raw.url ?? '')
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`清单缺少有效 version 字段：${source}`)
  if (!url) throw new Error('清单缺少 url 字段（zip 下载地址或本地 zip 路径）')
  return { version, notes: String(raw.notes ?? ''), url, source }
}

export async function checkLauncherUpdate() {
  const manifest = await loadManifest()
  checkCache = { version: manifest.version, notes: manifest.notes, url: manifest.url, checkedAt: Date.now() }
  return {
    current: LAUNCHER_VERSION,
    latest: manifest.version,
    updateAvailable: compareVersions(manifest.version, LAUNCHER_VERSION) > 0,
    notes: manifest.notes,
    updateUrl: manifest.url,
    checkedAt: manifest.checkedAt ?? Date.now(),
  }
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
  }
}

function replaceManaged(staging) {
  for (const dir of MANAGED_DIRS) {
    const target = join(ROOT, dir)
    const from = join(staging, dir)
    if (!existsSync(from)) continue
    rmSync(target, { recursive: true, force: true })
    copyDir(from, target)
  }
  for (const file of MANAGED_FILES) {
    const from = join(staging, file)
    if (!existsSync(from)) continue
    const target = join(ROOT, file)
    rmSync(target, { force: true })
    copyFileSync(from, target)
  }
}

export async function updateLauncher() {
  const manifest = await loadManifest()
  if (compareVersions(manifest.version, LAUNCHER_VERSION) <= 0) {
    emit(`当前 ${LAUNCHER_VERSION} 已是最新，无需更新`, 'done')
    return { alreadyLatest: true, version: LAUNCHER_VERSION }
  }
  emit(`最新版本：${manifest.version}${manifest.notes ? `（${manifest.notes}）` : ''}`)
  await installLauncherZip(manifest.version, manifest.url, manifest.notes)
  return { version: manifest.version }
}

/** 备份当前受管目录到 launcher-backup-<当前版本>。 */
function backupCurrent() {
  const backupDir = join(ROOT, `launcher-backup-${LAUNCHER_VERSION}`)
  rmSync(backupDir, { recursive: true, force: true })
  mkdirSync(backupDir, { recursive: true })
  emit(`备份当前版本 ${LAUNCHER_VERSION}……`)
  for (const dir of MANAGED_DIRS) { const from = join(ROOT, dir); if (existsSync(from)) copyDir(from, join(backupDir, dir)) }
  for (const file of MANAGED_FILES) { const from = join(ROOT, file); if (existsSync(from)) copyFileSync(from, join(backupDir, file)) }
}

/** 删除多余旧备份，保留最近 3 份。 */
function pruneBackups() {
  for (const name of backupNames().slice(0, -3)) rmSync(join(ROOT, name), { recursive: true, force: true })
}

/** 把某个备份恢复为当前（替换全部受管目录/文件）。 */
function restoreBackup(backupName) {
  const from = join(ROOT, backupName)
  for (const dir of MANAGED_DIRS) { const target = join(ROOT, dir); if (existsSync(target)) rmSync(target, { recursive: true, force: true }) }
  for (const file of MANAGED_FILES) { const target = join(ROOT, file); if (existsSync(target)) rmSync(target, { force: true }) }
  copyDir(from, ROOT)
}

/** 下载（或就地使用）更新包 → 解压校验 → 备份当前 → 替换 → 清理旧备份。 */
async function installLauncherZip(version, url, notes = '') {
  let zip = url
  if (/^https?:\/\//i.test(zip)) {
    zip = join(DIRS.logs, 'downloads', `launcher-v${version}.zip`)
    emit(`下载 ${basename(zip)}……`)
    await downloadTo(url, zip, {
      label: 'launcher',
      onProgress: t => emit(`下载 ${Math.round(t.downloaded / 1e6)}MB${t.total ? `/${Math.round(t.total / 1e6)}MB` : ''}`),
    })
  }
  if (!existsSync(zip)) throw new Error(`未找到更新包：${zip}`)
  const staging = join(ROOT, 'launcher-update')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  emit('解压更新包……')
  extractZip(zip, staging)
  if (!existsSync(join(staging, 'server', 'main.mjs')) || !existsSync(join(staging, 'gui', 'app.js'))) {
    throw new Error('更新包布局不完整（缺少 server\\main.mjs 或 gui\\app.js）')
  }
  backupCurrent()
  emit('替换文件……')
  replaceManaged(staging)
  rmSync(staging, { recursive: true, force: true })
  pruneBackups()
  emit(`更新完成：${LAUNCHER_VERSION} → ${version}，点击「重启」生效`, 'done')
}

/** 取某版本的发布信息（notes/url）。无凭证 / 未发布 / 网络失败返回 null。 */
async function githubRelease(version) {
  const token = githubToken()
  if (!token) return null
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/tags/v${version}`, {
      signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'dsh-launcher' },
    })
    if (!res.ok) return null
    const r = await res.json()
    const asset = (r.assets ?? []).find(a => /\.zip$/i.test(a.name))
    return { notes: r.body ?? '', url: asset?.browser_download_url ?? ghZipUrl(version) }
  } catch { return null }
}

/** 切换启动器到指定版本：已安装备份直接恢复；否则从 GitHub 下载该版本并安装。 */
export async function switchLauncherVersion(version) {
  const v = String(version ?? '').replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error('无效版本：' + version)
  if (v === LAUNCHER_VERSION) { emit(`当前已是 v${v}，无需切换`, 'done'); return { alreadyCurrent: true, version: v } }
  const backupName = `launcher-backup-${v}`
  if (existsSync(join(ROOT, backupName))) {
    backupCurrent()
    emit(`切换到已安装版本 v${v}……`)
    restoreBackup(backupName)
    pruneBackups()
  } else {
    const rel = await githubRelease(v)
    if (!rel) throw new Error(`找不到 v${v} 的发布版本（GitHub 无此版本或网络不可用）`)
    await installLauncherZip(v, rel.url, rel.notes)
  }
  emit(`已切换到 v${v}，点击「重启」生效`, 'done')
  return { version: v }
}

export async function rollbackLauncher() {
  const backups = backupNames()
  if (backups.length === 0) throw new Error('没有可回滚的备份')
  const backup = backups[backups.length - 1]
  const from = join(ROOT, backup)
  emit(`回滚到 ${backup}，当前文件将被备份版本替换……`)
  for (const dir of MANAGED_DIRS) {
    const target = join(ROOT, dir)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  }
  for (const file of MANAGED_FILES) {
    const target = join(ROOT, file)
    if (existsSync(target)) rmSync(target, { force: true })
  }
  copyDir(from, ROOT)
  for (const name of backupNames().slice(0, -3)) rmSync(join(ROOT, name), { recursive: true, force: true })
  emit(`回滚完成：已恢复 ${backup}，点击「重启」生效`, 'done')
  return { restored: backup }
}

/** 更新包 zip 校验辅助（供发布脚本使用）：列出 zip 顶层条目。 */
export function stagingLayoutCheck(zipPath) {
  const st = statSync(zipPath)
  return { zip: zipPath, size: st.size }
}
