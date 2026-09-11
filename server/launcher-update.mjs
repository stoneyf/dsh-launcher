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
import { DIRS, ROOT, readConfig, LAUNCHER_VERSION, backupDirs } from './core.mjs'
import { compareVersions, updateEvents } from './versions.mjs'
import { downloadTo, curlText, proxyForUrl } from './downloads.mjs'
import { extractZip } from './zip-utils.mjs'

const emit = (line, type = 'log') =>
  updateEvents.emit('event', { component: 'launcher', type, line: String(line).slice(0, 2000), ts: Date.now() })

export const CHANGELOG = `
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
  // 1) 获取 zip
  let zip = manifest.url
  if (/^https?:\/\//i.test(zip)) {
    zip = join(DIRS.logs, 'downloads', `launcher-v${manifest.version}.zip`)
    emit(`下载 ${basename(zip)}……`)
    await downloadTo(manifest.url, zip, {
      label: 'launcher',
      onProgress: t => emit(`下载 ${Math.round(t.downloaded / 1e6)}MB${t.total ? `/${Math.round(t.total / 1e6)}MB` : ''}`),
    })
  }
  if (!existsSync(zip)) throw new Error(`未找到更新包：${zip}`)
  // 2) 解压到 staging 并验证
  const staging = join(ROOT, 'launcher-update')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  emit('解压更新包……')
  extractZip(zip, staging)
  const verifyMain = join(staging, 'server', 'main.mjs')
  const verifyGui = join(staging, 'gui', 'app.js')
  if (!existsSync(verifyMain) || !existsSync(verifyGui)) {
    throw new Error('更新包布局不完整（缺少 server\\main.mjs 或 gui\\app.js）')
  }
  // 3) 备份当前版本
  const backupDir = join(ROOT, `launcher-backup-${LAUNCHER_VERSION}`)
  rmSync(backupDir, { recursive: true, force: true })
  mkdirSync(backupDir, { recursive: true })
  emit(`备份当前版本 ${LAUNCHER_VERSION}……`)
  for (const dir of MANAGED_DIRS) {
    const from = join(ROOT, dir)
    if (existsSync(from)) copyDir(from, join(backupDir, dir))
  }
  for (const file of MANAGED_FILES) {
    const from = join(ROOT, file)
    if (existsSync(from)) copyFileSync(from, join(backupDir, file))
  }
  // 4) 替换
  emit('替换文件……')
  replaceManaged(staging)
  // 5) 清理 staging 与旧备份（保留最近 3 份）
  rmSync(staging, { recursive: true, force: true })
  const old = backupNames().slice(0, -3)
  for (const name of old) rmSync(join(ROOT, name), { recursive: true, force: true })
  emit(`更新完成：${LAUNCHER_VERSION} → ${manifest.version}，点击「重启」生效`, 'done')
  return { version: manifest.version }
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
