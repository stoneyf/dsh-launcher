/**
 * 启动前体检（4.2）：在拉起 dsh 之前，把「会导致 dsh 起不来」的问题查出来并就地修好。
 *
 * 设计依据（2026-09-24 对 logs\dsh.err.log 的取证，325 条致命行归为 7 类）：
 *   ① 插件裸链解析失败  Cannot find package '@deepseek-ai/cordis'   （60 次）
 *   ② 其它模块缺失      ERR_MODULE_NOT_FOUND                        （80 次）
 *   ③ 会话日志损坏      corrupt session log                         （47 次）
 *   ④ harness 内部子树  Cannot find package '...\dsh-tools\index.js'（36 次）
 *   ⑤ 客户端 bundle 未构建 client bundle not found                   （30 次）
 *   ⑥ profile bundle 无法解析 cannot resolve profile bundle          （14 次）
 *   ⑦ profile patch YAML 重复键 duplicated mapping key               （ 8 次）
 *
 * 一个决定性事实：dsh-app-boot 的 loadProfileDirectory 对每个 bundle
 * **已经用 try/catch 容错**——解析失败只打印 `skipping profile bundle` 然后继续，
 * 不会让 dsh 起不来。所以「缺依赖」通常不是致命项，真正致命的是：
 *   · profile 的 package.json 不成 JSON        → readProfileManifest 抛错，直接失败
 *   · cordis.patch.yml YAML 语法错（重复键等）  → loadOverlayPatches 抛错，直接失败
 *   · 启动器自己那个坏条目（插件 import 时抛错）→ loader 应用条目失败，可能整体不启动
 * 因此本模块的定位是：**体检分级**（fatal / repairable / warn），能自动修的当场修，
 * 修不了的标记出来交给启动编排做「禁用该插件 + 重试」。
 *
 * 零第三方依赖，只用 Node 内置模块 + 启动器已有工具。
 */
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, copyFileSync,
} from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { DIRS, ROOT, readConfig, run, nodeExe, logTail } from './core.mjs'

/** 体检结论级别：fatal=不修就起不来；repairable=可自动修；warn=只是提醒。 */
export const LEVEL = { FATAL: 'fatal', REPAIRABLE: 'repairable', WARN: 'warn' }

/** profile 目录（活动 profile = DSH_HOME\profiles\web）。 */
export function profileDir(name = 'web') {
  return join(DIRS.data, 'profiles', name)
}

/** 从某目录起，按 Node 的解析顺序找包目录（与 dsh-app-boot 的 packageDirFromAnchor 同语义）。 */
export function resolvePackageDir(packageName, anchorDir) {
  try {
    const req = createRequire(join(anchorDir, 'package.json'))
    for (const searchPath of req.resolve.paths(packageName) ?? []) {
      const candidate = join(searchPath, packageName)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  } catch { /* 解析失败即视为找不到 */ }
  return null
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * 用 dsh 自己的 js-yaml 解析一段 YAML（与 dsh 解析 cordis.patch.yml 用的是同一个库、
 * 同一个版本，因此结论与 dsh 完全一致——不能自己写启发式扫描：曾据此误报 8 处
 * 「重复键」，实际那些 `- id:` 是同级列表项的首键，合法）。
 *
 * js-yaml 挂在 harness 的 dsh-app-boot 依赖里；取不到时返回 { available: false }，
 * 调用方应降级为「跳过该检查」而不是报错。
 */
let _yaml = null
let _yamlTried = false
function loadYaml() {
  if (_yamlTried) return _yaml
  _yamlTried = true
  const anchors = [
    join(DIRS.harness, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'),
    join(DIRS.harness, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue
    try {
      _yaml = createRequire(anchor)('js-yaml')
      return _yaml
    } catch { /* 试下一个锚点 */ }
  }
  return null
}

/** 解析 YAML 文本：{ available, ok, error, value }。 */
export function parseYaml(text) {
  const yaml = loadYaml()
  if (!yaml) return minimalYamlCheck(text)
  try {
    return { available: true, ok: true, error: null, value: yaml.load(text) }
  } catch (error) {
    return { available: true, ok: false, error: String(error.message ?? error), value: null }
  }
}

/**
 * 兜底：harness 没装好、拿不到 js-yaml 时用的极简检查。
 * 只认最容易犯、也最致命的一类错——**同一个映射里出现重复键**
 * （历史事故：cordis.patch.yml 第 57 行 duplicated mapping key，dsh 直接启动失败）。
 *
 * 难点是要把「同级列表项的首键」和「同一映射里的重复键」区分开：
 *   - id: foo        ← 列表项 A 的首键
 *     name: a
 *   - id: bar        ← 列表项 B 的首键（id 重复出现，但合法）
 * 判据：`- ` 开头的行会**开启一个新的列表项**，其缩进层级的键表要清空重算。
 */
export function minimalYamlCheck(text) {
  const seen = new Map() // 缩进 -> Map(key -> 行号)
  const dups = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '')
    if (!line.trim()) continue
    if (/^\s*-\s*$/.test(line)) continue
    const indent = line.length - line.trimStart().length
    const isItem = /^\s*-\s+/.test(line)
    const m = /^\s*-\s+([A-Za-z0-9_.$-]+)\s*:/.exec(line) ?? /^\s*([A-Za-z0-9_.$-]+)\s*:/.exec(line)
    // 缩进变浅 → 回到上层作用域，清掉更深的键表
    for (const k of [...seen.keys()]) if (k > indent) seen.delete(k)
    if (isItem) {
      // 新列表项：该层级以及更深层级的键表全部重算
      for (const k of [...seen.keys()]) if (k >= indent) seen.delete(k)
    }
    if (!m) continue
    const key = m[1]
    const scope = seen.get(indent) ?? new Map()
    if (scope.has(key)) dups.push({ key, line: i + 1, first: scope.get(key) })
    else scope.set(key, i + 1)
    seen.set(indent, scope)
  }
  if (dups.length === 0) return { available: false, ok: true, error: null, value: null, fallback: true }
  return {
    available: false,
    ok: false,
    fallback: true,
    error: `疑似重复键（js-yaml 不可用，使用内置检查）：` +
      dups.map(d => `第 ${d.line} 行 "${d.key}" 与第 ${d.first} 行重复`).join('；'),
    value: null,
  }
}

/**
 * 找出「同一 patch 列表里重复出现的 id」。
 * 注意：重复 id 本身**不是** YAML 语法错误（是合法的两个列表项），但会让 patch 语义
 * 变得含糊（后者覆盖前者），属于该提示的配置问题。返回 [{ id, lines: [n, m] }]。
 */
export function findDuplicateIds(text) {
  const seen = new Map()
  const dup = new Map()
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*-\s+id:\s*(\S+)/.exec(line)
    if (!m) return
    const id = m[1].replace(/^['"]|['"]$/g, '')
    if (seen.has(id)) dup.set(id, [...(dup.get(id) ?? [seen.get(id)]), i + 1])
    else seen.set(id, i + 1)
  })
  return [...dup].map(([id, lines]) => ({ id, lines }))
}

/** 检查 dsh 本体是否装好（harness\node_modules\@deepseek-ai\dsh\lib\bin.js）。 */
export function checkHarness() {
  const bin = join(DIRS.harness, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) {
    return { id: 'harness', level: LEVEL.FATAL, ok: false, title: 'Harness 本体缺失', detail: `找不到 ${bin}`, fix: '需运行 setup.bat 重新安装 Harness' }
  }
  let version = ''
  try { version = readJson(join(DIRS.harness, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')).version } catch { /* 忽略 */ }
  return { id: 'harness', level: LEVEL.FATAL, ok: true, title: 'Harness 本体完整', detail: version ? `dsh ${version}` : bin }
}

/**
 * 检查 profile：package.json 是否可解析、bundles 是否都能解析到、缺哪些依赖。
 * 这是 4.2 的核心检查——「缺依赖」可自动装，「package.json 坏了」要能报出来。
 */
export function checkProfile(name = 'web') {
  const dir = profileDir(name)
  const results = []
  const pkgFile = join(dir, 'package.json')
  if (!existsSync(pkgFile)) {
    return [{
      id: 'profile-manifest', level: LEVEL.FATAL, ok: false,
      title: 'profile 缺少 package.json',
      detail: pkgFile,
      fix: 'Harness 会在首次启动时自动初始化该 profile',
    }]
  }
  let pkg = null
  try {
    pkg = readJson(pkgFile)
  } catch (error) {
    // 致命：dsh-app-boot 的 readProfileManifest 会直接抛错，dsh 完全起不来
    return [{
      id: 'profile-manifest', level: LEVEL.FATAL, ok: false,
      title: 'profile 的 package.json 不是合法 JSON',
      detail: `${error.message}`,
      fix: '从备份恢复该文件（启动器会在体检前自动备份一份）',
    }]
  }
  results.push({ id: 'profile-manifest', level: LEVEL.FATAL, ok: true, title: 'profile package.json 可解析', detail: pkg.name ?? basename(dir) })

  const bundles = pkg.dsh?.profile?.bundles ?? []
  const deps = pkg.dependencies ?? {}
  // 与 dsh-app-boot 的 installAnchor 对齐：内置 bundle 从 dsh 安装处解析
  const installAnchorDir = dirname(join(DIRS.harness, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))

  const missing = []
  for (const b of bundles) {
    if (b.startsWith('@deepseek-ai/')) {
      if (!resolvePackageDir(b, installAnchorDir) && !resolvePackageDir(b, dir)) missing.push(b)
      continue
    }
    if (!resolvePackageDir(b, dir)) missing.push(b)
  }
  // bundles 里没有、但 dependencies 里声明的（通常无害，但缺了会留下半成品状态）
  // 内置包（@deepseek-ai/*）由 harness 提供，不在 profile 内解析属正常，排除掉避免误报。
  const missingDeps = Object.keys(deps)
    .filter(d => !d.startsWith('@deepseek-ai/'))
    .filter(d => !resolvePackageDir(d, dir))

  if (missing.length === 0) {
    results.push({ id: 'profile-bundles', level: LEVEL.REPAIRABLE, ok: true, title: `${bundles.length} 个插件 bundle 全部可解析`, detail: bundles.join(', ') })
  } else {
    results.push({
      id: 'profile-bundles', level: LEVEL.REPAIRABLE, ok: false,
      title: `有 ${missing.length} 个 bundle 解析不到（dsh 会跳过它们，不致命）`,
      detail: missing.join(', '),
      fix: '自动执行 pnpm install 补齐缺失依赖',
      packages: missing,
    })
  }
  if (missingDeps.length > 0) {
    results.push({
      id: 'profile-deps', level: LEVEL.REPAIRABLE, ok: false,
      title: `有 ${missingDeps.length} 个声明依赖未安装`,
      detail: missingDeps.join(', '),
      fix: '自动执行 pnpm install 补齐缺失依赖',
      packages: missingDeps,
    })
  }
  return results
}

/** 检查 profile 的 cordis.patch.yml：YAML 语法错会直接让 dsh 起不来。 */
export function checkProfilePatch(name = 'web') {
  const file = join(profileDir(name), 'cordis.patch.yml')
  if (!existsSync(file)) {
    return [{ id: 'profile-patch', level: LEVEL.FATAL, ok: true, title: 'profile 无 patch 文件（正常）', detail: file }]
  }
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch (error) {
    return [{ id: 'profile-patch', level: LEVEL.FATAL, ok: false, title: 'profile patch 无法读取', detail: error.message, fix: '检查文件权限' }]
  }
  const parsed = parseYaml(text)
  const out = []
  if (!parsed.ok) {
    out.push({
      id: 'profile-patch', level: LEVEL.FATAL, ok: false,
      title: parsed.fallback
        ? 'profile patch 疑似有重复键（dsh 会直接启动失败）'
        : 'profile patch YAML 语法错误（dsh 会直接启动失败）',
      detail: parsed.error,
      fix: '自动备份并移掉重复的那一行',
      file,
      repair: 'duplicate-key',
    })
  } else if (!parsed.available) {
    // js-yaml 取不到（harness 未装好），内置兜底检查也没发现问题 → 如实说明，不谎报「已检查」
    out.push({ id: 'profile-patch', level: LEVEL.FATAL, ok: true, title: 'profile patch 已用内置检查（js-yaml 不可用）', detail: file })
  } else {
    out.push({ id: 'profile-patch', level: LEVEL.FATAL, ok: true, title: 'profile patch YAML 合法', detail: file })
  }
  // 重复 id：不致命（合法 YAML），但语义含糊，提示用户
  const dupIds = findDuplicateIds(text)
  if (dupIds.length > 0) {
    out.push({
      id: 'profile-patch-dupids', level: LEVEL.WARN, ok: false,
      title: `profile patch 有 ${dupIds.length} 个重复 id（YAML 合法，但后者会覆盖前者）`,
      detail: dupIds.map(d => `"${d.id}" 出现在第 ${d.lines.join('、')} 行`).join('；'),
      fix: '确认是否有意为之（如用 disabled: true 关闭某插件）；否则删掉多余那条',
      advisory: true,
    })
  }
  return out
}

/**
 * 检查「插件自带 patch」里有没有会让 loader 报错的条目。
 * 这里只做静态可判断的一类：bundles 里出现、但自身 dsh.bundle 声明缺失的包。
 */
export function checkBundleManifests(name = 'web') {
  const dir = profileDir(name)
  let pkg = null
  try { pkg = readJson(join(dir, 'package.json')) } catch { return [] }
  const bundles = pkg.dsh?.profile?.bundles ?? []
  const bad = []
  for (const b of bundles) {
    if (b.startsWith('@deepseek-ai/')) continue
    const p = resolvePackageDir(b, dir)
    if (!p) continue
    try {
      const m = readJson(join(p, 'package.json'))
      if (m.dsh?.bundle === undefined) bad.push({ name: b, reason: 'package.json 未声明 dsh.bundle' })
    } catch (error) {
      bad.push({ name: b, reason: `package.json 读取失败：${error.message}` })
    }
  }
  if (bad.length === 0) return [{ id: 'bundle-manifests', level: LEVEL.REPAIRABLE, ok: true, title: '插件 bundle 声明齐全', detail: `${bundles.length} 个` }]
  return [{
    id: 'bundle-manifests', level: LEVEL.REPAIRABLE, ok: false,
    title: `${bad.length} 个插件缺 dsh.bundle 声明（dsh 会跳过，不致命）`,
    detail: bad.map(b => `${b.name}：${b.reason}`).join('；'),
    fix: '自动禁用这些插件（从 bundles 移除）',
    plugins: bad.map(b => b.name),
  }]
}

/**
 * 检查插件自身声明的**运行时**依赖能否解析。
 *
 * 关键教训（2026-09-24）：不能用 peerDependencies / devDependencies 判断。
 * dsh 的客户端插件（如 dsh-client-ui-*）把 react / react-dom 放在 devDependencies，
 * 打包时已内联进客户端 bundle，运行时根本不需要它们在磁盘上——若按 peer 判，
 * 会对每个客户端插件误报「缺 react」，进而触发毫无意义的重复安装。
 * 同理 @deepseek-ai/cordis 由 harness 安装提供，从 profile 目录解析不到是正常的。
 *
 * 判定规则：
 *   · dependencies  ——必须能解析（真缺了就 Cannot find package），从插件目录或 profile 解析
 *   · peerDependencies ——只有在「harness 与 profile 都解析不到」时才算缺，且降级为 WARN
 */
export function checkPluginDeps(name = 'web') {
  const dir = profileDir(name)
  let pkg = null
  try { pkg = readJson(join(dir, 'package.json')) } catch { return [] }
  const bundles = pkg.dsh?.profile?.bundles ?? []
  const dshAnchor = dirname(join(DIRS.harness, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const resolvableOutside = d => Boolean(resolvePackageDir(d, dshAnchor)) || Boolean(resolvePackageDir(d, dir))

  const broken = []
  const peerWarn = []
  for (const b of bundles) {
    if (b.startsWith('@deepseek-ai/')) continue
    const p = resolvePackageDir(b, dir)
    if (!p) continue
    let m = null
    try { m = readJson(join(p, 'package.json')) } catch { continue }
    const hard = Object.keys(m.dependencies ?? {}).filter(d => !resolvePackageDir(d, p) && !resolvePackageDir(d, dir))
    const soft = Object.keys(m.peerDependencies ?? {})
      .filter(d => !resolvePackageDir(d, p) && !resolvableOutside(d))
    if (hard.length > 0) broken.push({ name: b, missing: hard })
    else if (soft.length > 0) peerWarn.push({ name: b, missing: soft })
  }
  const out = []
  if (broken.length === 0) {
    out.push({ id: 'plugin-deps', level: LEVEL.REPAIRABLE, ok: true, title: '插件运行时依赖齐全', detail: `${bundles.length} 个插件` })
  } else {
    out.push({
      id: 'plugin-deps', level: LEVEL.REPAIRABLE, ok: false,
      title: `${broken.length} 个插件的运行时依赖装不全（加载时会报 Cannot find package）`,
      detail: broken.map(x => `${x.name} 缺：${x.missing.join('、')}`).join('；'),
      fix: '自动执行 pnpm install；仍失败则禁用该插件',
      plugins: broken.map(x => x.name),
    })
  }
  if (peerWarn.length > 0) {
    out.push({
      id: 'plugin-peers', level: LEVEL.WARN, ok: false,
      title: `${peerWarn.length} 个插件的 peer 依赖两处都找不到（多为客户端插件的打包依赖，通常无害）`,
      detail: peerWarn.map(x => `${x.name}：${x.missing.join('、')}`).join('；'),
      fix: '一般无需处理；若该插件加载报错再禁用',
      advisory: true,
    })
  }
  return out
}

/** 检查会话日志损坏：dsh 会在 apply loader entry workspace 时因损坏日志而失败。 */
export function checkSessionLogs(limit = 400) {
  const dir = join(DIRS.data, 'sessions')
  const id = 'session-logs'
  if (!existsSync(dir)) {
    return [{ id, level: LEVEL.WARN, ok: true, title: '无会话数据目录', detail: dir }]
  }
  const broken = []
  let scanned = 0
  const walk = (d, depth = 0) => {
    if (depth > 2 || scanned > limit) return
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned > limit) return
      const full = join(d, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!/^session\.v\d+\.jsonl(\.zstd)?$/.test(e.name)) continue
      scanned++
      try {
        const st = statSync(full)
        if (st.size === 0) { broken.push({ file: full, reason: '0 字节空文件' }); continue }
        // 只读文件头判断是否为合法 JSON（压缩的不解压，交给 dsh 自己处理）
        if (!e.name.endsWith('.zstd')) {
          const head = readFileSync(full, 'utf8').split(/\r?\n/, 1)[0]
          try { JSON.parse(head) } catch { broken.push({ file: full, reason: '首行不是合法 JSON' }) }
        }
      } catch { /* 读不到就跳过 */ }
    }
  }
  walk(dir)
  if (broken.length === 0) {
    return [{ id, level: LEVEL.WARN, ok: true, title: `会话日志正常（抽查 ${scanned} 个）`, detail: dir }]
  }
  return [{
    id, level: LEVEL.WARN, ok: false,
    title: `${broken.length} 个会话日志可能损坏（会让 dsh 启动时报 corrupt session log）`,
    detail: broken.slice(0, 8).map(b => `${basename(dirname(b.file))}：${b.reason}`).join('；'),
    fix: '移动到 _broken-sessions 备份目录隔离（不自动删除）',
    files: broken.map(b => b.file),
  }]
}

/**
 * 隔离损坏的会话日志：移动到 data\_broken-sessions\（保留原相对路径）。
 * 只移动、不删除——用户可能想事后修复。
 */
export function quarantineBrokenSessions(files) {
  const dest = join(DIRS.data, '_broken-sessions')
  const moved = []
  for (const f of files) {
    try {
      if (!existsSync(f)) continue
      const rel = f.slice(join(DIRS.data, 'sessions').length).replace(/^[\\/]/, '')
      const target = join(dest, rel)
      mkdirSync(dirname(target), { recursive: true })
      renameSync(f, target)
      moved.push({ from: f, to: target })
    } catch { /* 单个失败不影响其它 */ }
  }
  return { ok: moved.length > 0, moved }
}

/** 跑一遍全部体检，返回 { ok, fatal, repairable, warn, checks }。 */
export function runChecks(name = 'web') {
  const checks = [
    checkHarness(),
    ...checkProfile(name),
    ...checkProfilePatch(name),
    ...checkBundleManifests(name),
    ...checkPluginDeps(name),
    ...checkSessionLogs(),
  ]
    // 防御：任何单项检查写错（返回 undefined / 漏 level）都不该污染整体结论，
    // 也不该让启动流程崩掉——归一化成一个明确的警告项。
    .filter(Boolean)
    .flat()
    .map(c => ({ level: LEVEL.WARN, ...c, title: c.title ?? String(c.id ?? '未知检查项') }))
  const failed = checks.filter(c => !c.ok && c.advisory !== true)
  return {
    ok: failed.length === 0,
    fatal: failed.filter(c => c.level === LEVEL.FATAL),
    repairable: failed.filter(c => c.level === LEVEL.REPAIRABLE),
    warn: failed.filter(c => c.level === LEVEL.WARN),
    advisory: checks.filter(c => c.advisory === true),
    checks,
    at: new Date().toISOString(),
  }
}

// ---------- 自动修复动作 ----------

/** 备份目录（每次体检/修复前把要动的文件备份到这里，可回滚）。 */
function backupRoot() {
  const dir = join(DIRS.data, '_preflight-backup')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 把文件备份到 _preflight-backup\<标签>-<时间戳>\<相对路径>，返回备份路径。 */
export function backupFile(file, label = 'preflight') {
  try {
    if (!existsSync(file)) return null
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(backupRoot(), `${label}-${stamp}`, basename(file))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(file, dest)
    return dest
  } catch { return null }
}

/** 原子写：先写临时文件再 rename，避免半成品状态。 */
function writeAtomic(file, content) {
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, file)
}

/** 缺依赖 → 在 profile 目录跑 pnpm install（dsh plugin --profile 就是 pnpm 的转发）。 */
export function installProfileDeps(name = 'web', { timeoutMs = 300000 } = {}) {
  const dir = profileDir(name)
  const bin = join(DIRS.harness, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) return { ok: false, detail: `Harness bin 不存在：${bin}` }
  const r = run(nodeExe(), [bin, 'plugin', '--profile', name, 'install'], {
    cwd: dir,
    timeout: timeoutMs,
    env: {
      ...process.env,
      DSH_HOME: DIRS.data,
      NPM_CONFIG_CACHE: DIRS.npmCache,
      PNPM_HOME: join(ROOT, 'vendor', 'pnpm-home'),
      COREPACK_HOME: join(ROOT, 'vendor', 'corepack-home'),
      PATH: `${DIRS.runtimeNode};${process.env.PATH ?? ''}`,
    },
  })
  const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).slice(-12).join('\n')
  return { ok: r.ok, detail: tail || '（无输出）' }
}

/** 从 profile 的 bundles 里移除指定插件（禁用），可回滚。 */
export function disablePlugins(plugins, name = 'web') {
  const file = join(profileDir(name), 'package.json')
  if (!existsSync(file)) return { ok: false, detail: 'profile package.json 不存在' }
  let pkg = null
  try { pkg = readJson(file) } catch (error) { return { ok: false, detail: `package.json 无法解析：${error.message}` } }
  const before = pkg.dsh?.profile?.bundles ?? []
  const removed = before.filter(b => plugins.includes(b))
  if (removed.length === 0) return { ok: true, detail: '无需禁用（都不在 bundles 里）', removed: [] }
  const backup = backupFile(file, 'disable-plugins')
  pkg.dsh.profile.bundles = before.filter(b => !plugins.includes(b))
  // 同时记到禁用清单，便于 GUI 展示与一键恢复
  const listFile = join(DIRS.data, 'disabled-plugins.json')
  let list = []
  try { list = readJson(listFile) } catch { list = [] }
  const at = new Date().toISOString()
  for (const p of removed) list.push({ name: p, at, reason: 'preflight: 导致启动失败的插件' })
  writeAtomic(listFile, JSON.stringify(list, null, 2))
  writeAtomic(file, JSON.stringify(pkg, null, 2) + '\n')
  return { ok: true, detail: `已禁用 ${removed.length} 个插件`, removed, backup }
}

/** 恢复被禁用的插件（放回 bundles）。 */
export function enablePlugins(plugins, name = 'web') {
  const file = join(profileDir(name), 'package.json')
  let pkg = null
  try { pkg = readJson(file) } catch (error) { return { ok: false, detail: error.message } }
  const before = pkg.dsh?.profile?.bundles ?? []
  backupFile(file, 'enable-plugins')
  const merged = [...before]
  for (const p of plugins) if (!merged.includes(p)) merged.push(p)
  pkg.dsh.profile.bundles = merged
  writeAtomic(file, JSON.stringify(pkg, null, 2) + '\n')
  const listFile = join(DIRS.data, 'disabled-plugins.json')
  try {
    const list = readJson(listFile).filter(x => !plugins.includes(x.name))
    writeAtomic(listFile, JSON.stringify(list, null, 2))
  } catch { /* 清单不存在 */ }
  return { ok: true, detail: `已恢复 ${plugins.length} 个插件` }
}

/** 修复 profile patch 的语法问题：删掉「后出现的那个重复键」所在行。 */
export function repairProfilePatch(name = 'web') {
  const file = join(profileDir(name), 'cordis.patch.yml')
  if (!existsSync(file)) return { ok: false, detail: 'patch 文件不存在' }
  const text = readFileSync(file, 'utf8')
  // 先用真正的解析器确认；不行再用兜底扫描定位行号
  const parsed = parseYaml(text)
  if (parsed.ok && parsed.available) return { ok: true, detail: '无语法问题', changed: false }
  const dups = findDuplicateKeyLines(text)
  if (dups.length === 0) {
    return { ok: false, detail: `无法自动定位问题（${parsed.error ?? '未知'}），需人工检查`, changed: false }
  }
  const drop = new Set(dups)
  const kept = text.split(/\r?\n/).filter((_, i) => !drop.has(i + 1))
  const backup = backupFile(file, 'repair-patch')
  writeAtomic(file, kept.join('\r\n'))
  return { ok: true, detail: `已移除 ${drop.size} 行重复键`, changed: true, backup, removedLines: [...drop] }
}

/** 定位「重复键」的行号（后出现的那一行）。基于 minimalYamlCheck 的同一套作用域逻辑。 */
export function findDuplicateKeyLines(text) {
  const seen = new Map()
  const dups = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '')
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const isItem = /^\s*-\s+/.test(line)
    const m = /^\s*-\s+([A-Za-z0-9_.$-]+)\s*:/.exec(line) ?? /^\s*([A-Za-z0-9_.$-]+)\s*:/.exec(line)
    for (const k of [...seen.keys()]) if (k > indent) seen.delete(k)
    if (isItem) for (const k of [...seen.keys()]) if (k >= indent) seen.delete(k)
    if (!m) continue
    const key = m[1]
    const scope = seen.get(indent) ?? new Map()
    if (scope.has(key)) dups.push(i + 1)
    else scope.set(key, i + 1)
    seen.set(indent, scope)
  }
  return dups
}

/**
 * 体检 + 自动修复主流程。
 * @param options.name profile 名
 * @param options.auto true=执行自动修复（装依赖/修 YAML/禁用坏插件）
 * @returns { before, after, actions, ok }
 */
export function preflight(name = 'web', { auto = true } = {}) {
  const before = runChecks(name)
  const actions = []
  if (!auto) return { before, after: before, actions, ok: before.ok }

  // 1) profile patch YAML 重复键（致命）→ 修
  const patchCheck = before.fatal.find(c => c.id === 'profile-patch')
  if (patchCheck) {
    const r = repairProfilePatch(name)
    actions.push({ action: 'repair-profile-patch', ...r })
  }

  // 2) 缺依赖（可修）→ 装
  const needInstall = before.repairable.some(c => c.id === 'profile-bundles' || c.id === 'profile-deps' || c.id === 'plugin-deps')
  if (needInstall) {
    const r = installProfileDeps(name)
    actions.push({ action: 'install-deps', ...r })
  }

  // 3) 装完再查一遍；仍然解析不到的插件 → 禁用（dsh 本来也会跳过，但禁用可避免告警噪音）
  const mid = runChecks(name)
  const stillBad = new Set()
  for (const c of mid.repairable) {
    if (c.id === 'profile-bundles' && c.packages) for (const p of c.packages) stillBad.add(p)
    if (c.id === 'bundle-manifests' && c.plugins) for (const p of c.plugins) stillBad.add(p)
    if (c.id === 'plugin-deps' && c.plugins) for (const p of c.plugins) stillBad.add(p)
  }
  if (stillBad.size > 0) {
    const r = disablePlugins([...stillBad], name)
    actions.push({ action: 'disable-plugins', plugins: [...stillBad], ...r })
  }

  const after = runChecks(name)
  return { before, mid, after, actions, ok: after.ok }
}

export const __test__ = { findDuplicateIds, parseYaml, minimalYamlCheck, findDuplicateKeyLines, writeAtomic }
