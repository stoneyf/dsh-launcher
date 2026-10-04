/**
 * DSH 本地启动器 V3 后端 — 核心模块
 * 路径常量、launcher.env 读写、settings.yaml 片段同步、通用工具。
 * 零第三方依赖，仅使用 Node 内置模块。
 * V3 新增：DSH_LAUNCHER_ROOT 环境变量可覆盖根目录（测试用）；
 * 端口占用者查询（netstat）与等待端口释放，服务重启编排依赖。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'

export const LAUNCHER_VERSION = '4.5.2'

const serverDir = dirname(fileURLToPath(import.meta.url))
/** 根目录：默认取 server 上一级；DSH_LAUNCHER_ROOT 可覆盖（与传给 dsh 进程的同名变量一致，便于测试与外部发现）。 */
export const ROOT = resolve(process.env.DSH_LAUNCHER_ROOT || join(serverDir, '..'))

export const DIRS = {
  root: ROOT,
  config: join(ROOT, 'config'),
  data: join(ROOT, 'data'),
  logs: join(ROOT, 'logs'),
  models: join(ROOT, 'models'),
  harness: join(ROOT, 'harness'),
  llm: join(ROOT, 'llm'),
  runtimeNode: join(ROOT, 'runtime', 'node'),
  gui: join(ROOT, 'gui'),
  tarballs: join(ROOT, 'vendor', 'tarballs'),
  npmCache: join(ROOT, 'npm-cache'),
}

export const CONFIG_FILE = join(DIRS.config, 'launcher.env')
export const SETTINGS_FILE = join(DIRS.data, 'settings.yaml')

/** js-yaml：复用 harness 自带的那份（与 dsh 解析 profile patch 用同一个库，避免行为差异）。
 *  启动器本体保持零第三方依赖——不装包，借 harness 的 node_modules。 */
const yaml = (() => {
  for (const anchor of [join(DIRS.harness, 'node_modules'), join(ROOT, 'node_modules')]) {
    try {
      return createRequire(join(anchor, 'noop.js'))('js-yaml')
    } catch { /* 换下一个锚点 */ }
  }
  return null
})()

export const CONFIG_DEFAULTS = {
  LAUNCHER_PORT: '7610',
  DSH_HOST: '127.0.0.1',
  DSH_PORT: '3080',
  OPEN_BROWSER: '1',
  LLM_HOST: '127.0.0.1',
  LLM_PORT: '8080',
  LLM_MODEL: 'models\\Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf',
  LLM_MMPROJ: '',
  LLM_CTX: 'auto',
  LLM_MAXTOKENS: 'auto',
  LLM_NGPU: '999',
  LLM_PARALLEL: '1',
  // 4.4：KV 缓存量化。'' = 不压缩（f16）| q8_0 | q5_0 | q4_0。
  // llama.cpp 要求 KV 量化必须同时开 Flash Attention，startLlm 会自动补 -fa on。
  // 实测（Q6_K + -c 114688）：f16 占用 29647 MiB，q8_0 只要 26678 MiB（省 2.9GB），
  // 加载 18s → 12.1s。省下的显存由 resolveCtx() 自动换成更大的上下文。
  LLM_KV_QUANT: '',
  // 4.4：MoE 专家层放内存（--cpu-moe / -n-cpu-moe）。'' = 不启用 | all | 数字 N（前 N 层）。
  // 给将来的 MoE 模型（如 Qwen3.8-35B-A3B）预留：权重放内存可给显存腾地方。
  LLM_CPU_MOE: '',
  // 4.4：多模型 router 模式。'' = 自动（models 目录里有 gguf 就开，4.4.3 起默认）、
  // '1' = 强制开（--models-dir 指向 models 目录，按需加载、热切换，不用重启服务）、
  // '0' = 强制关（单模型，-m 指定一个文件）。
  LLM_ROUTER: '',
  // router 模式同时驻留的模型数上限。本机 32GB 显存一次只装得下一个 27B，故默认 1。
  LLM_ROUTER_MAX: '1',
  // 追加给 llama-server 的额外命令行参数（空格分隔）。默认关掉思考链：
  // 本机模型是推理模型，chat template 默认保留 reasoning，每轮回复都带
  // reasoning_content 字段；DSH 端 llm-deepseek 按 thinking: disabled 构造
  // 请求，两边对不上会报 "Messages expected a JSON object"。
  LLM_EXTRA_ARGS: '--reasoning off',
  LLM_API_KEY: 'local',
  HUB_ALLOWLIST_ONLY: '0',
  HUB_MIRROR: 'https://hf-mirror.com',
  THEME: 'dark',
  AUTO_START: '0',
  AUTO_START_SERVICES: '0',
  LAUNCHER_UPDATE_URL: '',
  DOWNLOAD_PROXY: '',
  DIRECT_HOSTS: '',
}

// ---------- 开机自启（仅登录后） ----------
// 4.1.9：**去掉免登录**。此前用「计划任务（ONSTART + SYSTEM）+ HKCU Run」双机制，
// 让开机时无人登录也能跑服务；但它引入了两个实例（SYSTEM 会话 0 + 登录会话 1）并存的
// 架构问题：① 开机时 SYSTEM 实例正忙于加载 15GB 本地模型，登录实例附着探测容易超时
// → 退化成随机端口 → 出现「端口已占用」提示；② 服务归属混乱（llama 是 SYSTEM 实例的
// 子进程，登录实例的 llm.pid 却是空的）→ 界面上点「停止全部」停不掉；③ SYSTEM 实例在
// Session 0 无界面，用户看不见它在管什么。
// 现在只保留 HKCU Run 登录项：用户登录后拉起启动器（托盘/窗口）+（若勾选
// 「开机自动启动服务」）本地模型与 Harness。开机到登录之间不跑任何东西；
// 「免登录也能用」改由用户自己的远程控制方案解决。
// 注意：setAutoStart 仍会**主动清理**历史遗留的计划任务，避免旧版本创建的任务
// 在升级后继续把 SYSTEM 实例拉起来。
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'DSH Launcher'
const LEGACY_TASK_NAME = 'DSH Launcher Autostart'

/** 删除历史遗留的免登录计划任务（4.1.8 及更早版本创建）。 */
function removeLegacyAutoStartTask() {
  try {
    spawnSync('schtasks', ['/Delete', '/F', '/TN', LEGACY_TASK_NAME], { windowsHide: true })
  } catch { /* 任务不存在或 schtasks 不可用 */ }
}

/** 写入/删除「开机自启」：只写 HKCU Run（登录后拉起），并清理历史遗留的计划任务。 */
export function setAutoStart(enabled) {
  const exe = join(ROOT, 'dsh-launcher.exe')
  const target = existsSync(exe) ? exe : join(ROOT, 'launcher.bat')
  // 无论开启还是关闭，都清掉旧版留下的免登录计划任务
  removeLegacyAutoStartTask()
  const data = `"${target}"${enabled ? ' --silent' : ''}`
  if (enabled) {
    spawnSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', data, '/f'], { windowsHide: true })
  } else {
    spawnSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true })
  }
  return { enabled: Boolean(enabled), target }
}

/** 读取当前自启状态（只看 HKCU Run；历史遗留计划任务会被顺手清理）。 */
export function isAutoStart() {
  removeLegacyAutoStartTask()
  try {
    const r = spawnSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { windowsHide: true, encoding: 'utf8' })
    if (r.status === 0 && /DSH Launcher/i.test(r.stdout ?? '')) return true
    if (r.status === 0) return false
  } catch { /* reg 不可用 */ }
  return readConfig().AUTO_START === '1'
}

export function ensureDirs() {
  for (const dir of [DIRS.config, DIRS.data, DIRS.logs, DIRS.models, DIRS.npmCache]) {
    mkdirSync(dir, { recursive: true })
  }
}

/** 读取 launcher.env，返回全部键值（缺失项用默认值）。 */
export function readConfig() {
  const cfg = { ...CONFIG_DEFAULTS }
  if (existsSync(CONFIG_FILE)) {
    for (const raw of readFileSync(CONFIG_FILE, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
      const i = line.indexOf('=')
      if (i <= 0) continue
      cfg[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  return cfg
}

/** 合并写入 launcher.env（保留注释行，按键更新，新键追加）。 */
export function writeConfig(updates) {
  mkdirSync(DIRS.config, { recursive: true })
  const lines = existsSync(CONFIG_FILE)
    ? readFileSync(CONFIG_FILE, 'utf8').split(/\r?\n/)
    : []
  const merged = { ...readConfig(), ...updates }
  const written = new Set()
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('#') && !t.startsWith(';')) {
      const i = t.indexOf('=')
      if (i > 0) {
        const key = t.slice(0, i).trim()
        if (Object.prototype.hasOwnProperty.call(merged, key)) {
          out.push(`${key}=${merged[key]}`)
          written.add(key)
          continue
        }
      }
    }
    out.push(line)
  }
  for (const [key, value] of Object.entries(merged)) {
    if (!written.has(key)) out.push(`${key}=${value}`)
  }
  writeFileSync(CONFIG_FILE, out.join('\r\n') + '\r\n', 'utf8')
}

export function modelPath() {
  const p = readConfig().LLM_MODEL
  return p.includes(':\\') || p.startsWith('\\\\') ? p : join(ROOT, p)
}

export function modelId() {
  return modelPath().split(/[\\/]/).pop().replace(/\.gguf$/i, '')
}

/** 视觉投影器（mmproj）路径；LLM_MMPROJ 为空表示不启用视觉，返回 null。 */
export function mmprojPath() {
  const p = readConfig().LLM_MMPROJ
  if (!p || !String(p).trim()) return null
  const v = String(p).trim()
  return v.includes(':\\') || v.startsWith('\\\\') ? v : join(ROOT, v)
}

/** 某个模型配套的视觉投影器（mmproj）路径；没有就返回 null。
 *
 *  为什么必须「按模型」：router 模式下 llama-server 一次扫描整个 models 目录，而
 *  `--mmproj` 是**全局**参数 —— 挂上去会强加给目录里所有模型（投影器与模型对不上时
 *  加载会失败）。所以 router 模式改由 preset.ini 的**逐模型节**带 `mmproj = <path>`。
 *
 *  约定（以后换任何视觉模型都只放文件、不改代码）：投影器放 <ROOT>\mmproj\ 下，
 *  文件名去掉 `-mmproj…` 后缀后，是模型名的前缀。
 *  例：模型 `Qwen3-VL-8B-Instruct-UD-Q6_K_XL` 配
 *  `mmproj\Qwen3-VL-8B-Instruct-mmproj-F16.gguf`。
 *
 *  LLM_MMPROJ 显式指定时：单模型模式无条件采用（保持老行为）；router 模式要求前缀匹配，
 *  否则会把某个模型的投影器错挂到别的模型上。
 *  @param {string} [modelArg] gguf 路径；缺省 = 当前 LLM_MODEL
 *  @returns {string|null} */
export function mmprojFor(modelArg) {
  const model = modelArg || modelPath()
  const base = String(model).split(/[\\/]/).pop().replace(/\.gguf$/i, '').toLowerCase()
  const stemOf = (p) => String(p).split(/[\\/]/).pop().replace(/\.gguf$/i, '').replace(/-mmproj.*$/i, '').toLowerCase()
  const explicit = mmprojPath()
  if (explicit !== null) {
    if (!isRouterMode()) return explicit
    const s = stemOf(explicit)
    if (s !== '' && base.startsWith(s)) return explicit
  }
  const dir = join(ROOT, 'mmproj')
  if (!existsSync(dir)) return null
  let best = null
  try {
    for (const f of readdirSync(dir)) {
      if (!/\.gguf$/i.test(f)) continue
      const s = stemOf(f)
      if (s === '' || !base.startsWith(s)) continue
      if (best === null || s.length > stemOf(best).length) best = f
    }
  } catch { return null }
  return best === null ? null : join(dir, best)
}
export function llmBaseUrl() {
  const c = readConfig()
  return `http://${c.LLM_HOST}:${Number(c.LLM_PORT)}`
}

/** 替换 settings.yaml 顶层段（保留其他内容），与 V1 PowerShell 行为一致。 */
export function replaceYamlSection(content, sectionName, replacement) {
  const lines = content === '' ? [] : content.split(/\r?\n/)
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!/^\s/.test(line) && !line.startsWith('#') && line.trimStart().startsWith(`${sectionName}:`)) {
      i++
      while (i < lines.length && (/^\s/.test(lines[i]) || lines[i].trim() === '')) i++
      continue
    }
    out.push(line)
    i++
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  out.push(replacement)
  out.push('')
  return out.join('\r\n')
}

/** 探测模型 gguf：原生上下文 + 每 token KV 缓存字节数。按模型路径缓存；python/gguf 缺失返回 null。
 *  @param {string} [modelArg] 要探测的 gguf 路径；缺省 = 当前 LLM_MODEL。
 *  4.4：router 模式要逐个模型探测（每个模型的 kv_per_token / max_output 不同），故支持传路径。 */
const _probeCache = new Map()  // path -> result
export function probeModel(modelArg) {
  const model = modelArg || modelPath()
  if (_probeCache.has(model)) return _probeCache.get(model)
  const py = join(serverDir, 'probe_model.py')
  let result = null
  if (existsSync(py) && existsSync(model)) {
    try {
      const r = run('python', [py, model])
      if (r.ok) {
        const line = String(r.stdout).trim().split('\n').pop()
        if (line && line.startsWith('{')) result = JSON.parse(line)
      }
    } catch { /* 兜底：走固定上下文 */ }
  }
  _probeCache.set(model, result)
  return result
}

/** models 目录下的所有 gguf 文件名（已排序）。目录不存在返回空数组。 */
export function listGgufNames() {
  try {
    return readdirSync(DIRS.models).filter(n => /\.gguf$/i.test(n)).sort((a, b) => a.localeCompare(b))
  } catch { return [] }
}

/** 是否处于多模型 router 模式。
 *  '1' = 开；'0' = 关（单模型）；**留空 = 自动**（4.4.3 起的默认）：
 *  models 目录里只要有一个 gguf 就用 router，这样 dsh 对话里的模型下拉框能列出全部本地模型、
 *  选谁加载谁（配合 --models-preset/--models-autoload）。空目录回落单模型——否则
 *  llama-server 会因为没有可加载的模型而起不来。 */
export function isRouterMode() {
  const raw = String(readConfig().LLM_ROUTER ?? '').trim()
  if (raw === '1') return true
  if (raw === '0') return false
  return listGgufNames().length > 0
}

/** KV 缓存量化相对 f16 的占用系数（4.4）。q8_0 = 8bit/16bit = 0.5，依此类推。 */
export function kvQuantFactor() {
  const q = String(readConfig().LLM_KV_QUANT ?? '').trim().toLowerCase()
  if (q === 'q8_0') return 0.5
  if (q === 'q5_1' || q === 'q5_0') return 0.3125
  if (q === 'q4_1' || q === 'q4_0') return 0.25
  return 1  // '' / f16 / 未知值
}

/** 显存与上下文估算所针对的模型文件。
 *  单模型模式 = LLM_MODEL；router 模式 = LLM_MODEL（若该文件确实存在），否则目录里第一个 gguf。 */
export function vramTargetModelPath() {
  const configured = modelPath()
  if (!isRouterMode()) return configured
  if (existsSync(configured)) return configured
  const names = listGgufNames()
  return names.length > 0 ? join(DIRS.models, names[0]) : configured
}

/** GPU 总显存（MiB）；nvidia-smi 缺失/失败返回 0。 */
export function getTotalVramMiB() {
  try {
    const r = run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'])
    const n = Number(String(r.stdout).trim().split(/\s+/)[0])
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch { return 0 }
}

/** KV 缓存可用的显存预算（**单一真相源**，resolveCtx 与 ctxForModel 共用）。
 *  两条约束取更小者：
 *   ① 总显存 − 模型占用 − 固定安全余量 1024MiB；
 *   ② 总显存的 95% − 模型占用（留 5% 给桌面/浏览器/其它程序）。
 *  为什么要加 ②：实测 Qwen3-Coder-30B-A3B（24.5GB）只按 ① 算时占到了
 *  31966/32607 MiB（**97.9%**），只剩 0.6GB —— 桌面稍一用显存就有 OOM 风险。 */
const VRAM_USAGE_RATIO = 0.95
function kvBudgetFor(totalVram, modelVramMiB) {
  const byMargin = totalVram - modelVramMiB - 1024
  const byRatio = totalVram * VRAM_USAGE_RATIO - modelVramMiB
  return Math.min(byMargin, byRatio)
}

/** 解析上下文窗口：LLM_CTX=auto 时按显存自动计算（取能容纳的最大 16K 整数倍），否则用固定值。
 *  4.4：KV 缓存量化（LLM_KV_QUANT）后每 token 的 KV 占用按系数下降，
 *  这里同步折算——否则「省下来的显存白省」，auto 算出的上下文不会变大。 */
export function resolveCtx() {
  const cfg = readConfig()
  const raw = String(cfg.LLM_CTX ?? '').trim().toLowerCase()
  if (raw !== 'auto') return Number(cfg.LLM_CTX) || 32768
  const target = vramTargetModelPath()
  const probe = probeModel(target)
  const totalVram = getTotalVramMiB()
  const modelBytes = existsSync(target) ? statSync(target).size : 0
  if (!probe?.kv_per_token || !totalVram || !modelBytes) return 131072  // 兜底：探测不到用 128K
  const overheadMiB = 1536   // CUDA 上下文 + embedding + 杂项开销
  const modelVramMiB = modelBytes / 1048576 + overheadMiB
  const kvBudgetMiB = kvBudgetFor(totalVram, modelVramMiB)
  if (kvBudgetMiB <= 0) return 8192
  const kvPerToken = probe.kv_per_token * kvQuantFactor()
  let ctx = Math.floor(kvBudgetMiB * 1048576 / kvPerToken)
  if (probe.native_context) ctx = Math.min(ctx, probe.native_context)  // 不超过模型原生上限
  ctx = Math.floor(ctx / 16384) * 16384   // 向下取整到 16K 整数倍
  ctx = Math.max(ctx, 8192)               // 下限保护
  return ctx
}

/** 单模型自动上下文（B，4.5）：给定 gguf 路径，按「模型体积 + 剩余显存 + KV 压缩」算最大可容纳上下文。
 *  与 resolveCtx 同公式，但作用于任意模型文件（供 router 模式逐模型写 preset.ini）。
 *  @param {string} modelPath  gguf 文件绝对路径
 *  @returns {number} 上下文长度（16K 倍数，下限 8192，上限模型原生） */
export function ctxForModel(modelPath) {
  const probe = probeModel(modelPath)
  const totalVram = getTotalVramMiB()
  const modelBytes = existsSync(modelPath) ? statSync(modelPath).size : 0
  if (!probe?.kv_per_token || !totalVram || !modelBytes) return 131072  // 兜底
  const overheadMiB = 1536
  const modelVramMiB = modelBytes / 1048576 + overheadMiB
  const kvBudgetMiB = kvBudgetFor(totalVram, modelVramMiB)
  if (kvBudgetMiB <= 0) return 8192
  const kvPerToken = probe.kv_per_token * kvQuantFactor()
  let ctx = Math.floor(kvBudgetMiB * 1048576 / kvPerToken)
  if (probe.native_context) ctx = Math.min(ctx, probe.native_context)
  ctx = Math.floor(ctx / 16384) * 16384
  return Math.max(ctx, 8192)
}

/** 生成 llama.cpp INI preset 文件（B，4.5）：router 模式下每个模型各拿各的上下文。
 *  节名 = 文件名去 .gguf 后缀（llama.cpp 的 --alias 与此一致，实测确认）。
 *  写法：`[*]` 默认 ctx=0（模型原生），逐模型节覆盖 ctx-size。
 *  **必须无 BOM**（BOM 导致 llama.cpp 解析失败，实测）。
 *  @returns {{file:string, models:Array<{name:string, ctx:number}>}} */
export function buildLlmPreset() {
  const models = listGgufNames().map(name => {
    const p = join(DIRS.models, name)
    return {
      name: name.replace(/\.gguf$/i, ''),
      ctx: ctxForModel(p),
      // 这个模型配套的视觉投影器（没配就是 null）——只写进它自己的节，不污染别的模型。
      mmproj: mmprojFor(p),
    }
  })
  const lines = ['[*]', 'ctx-size = 0']
  for (const m of models) {
    lines.push('', `[${m.name}]`, `ctx-size = ${m.ctx}`)
    // 路径统一用正斜杠：preset 的值是「原样交给 CLI」的，反斜杠有被当转义的风险。
    if (m.mmproj) lines.push(`mmproj = ${String(m.mmproj).replace(/\\/g, "/")}`)
  }
  const file = join(DIRS.models, 'preset.ini')
  writeFileSync(file, lines.join('\n') + '\n', { encoding: 'utf8' })
  return { file, models }
}

/** 显存占用预估（4.4）：把「模型 + KV 缓存 + 开销」拆开显示，启动前就知道够不够。
 *  @returns {{model:string, modelMiB:number, kvMiB:number|null, overheadMiB:number,
 *             totalMiB:number, totalVramMiB:number, freeMiB:number|null, ctx:number,
 *             kvQuant:string, router:boolean, fits:boolean|null}} */
export function estimateVram() {
  const cfg = readConfig()
  const model = vramTargetModelPath()
  const probe = probeModel(model)
  const ctx = resolveCtx()
  const totalVramMiB = getTotalVramMiB()
  const overheadMiB = 1536
  const modelBytes = existsSync(model) ? statSync(model).size : 0
  const modelMiB = Math.round(modelBytes / 1048576) + overheadMiB
  const kvMiB = probe?.kv_per_token
    ? Math.round(ctx * probe.kv_per_token * kvQuantFactor() / 1048576)
    : null
  const totalMiB = modelMiB + (kvMiB ?? 0)
  return {
    model,
    modelMiB,
    kvMiB,
    overheadMiB,
    totalMiB,
    totalVramMiB,
    freeMiB: totalVramMiB ? totalVramMiB - totalMiB : null,
    ctx,
    kvQuant: String(cfg.LLM_KV_QUANT ?? '').trim() || 'f16',
    router: isRouterMode(),
    fits: totalVramMiB ? totalMiB <= totalVramMiB : null,
  }
}

/** 解析最大输出 token：LLM_MAXTOKENS=auto 时用模型自身上限（探测，缺省 32K），否则用固定值；最终都不超过上下文窗口。 */
export function resolveMaxTokens(ctx) {
  const cfg = readConfig()
  const raw = String(cfg.LLM_MAXTOKENS ?? '').trim().toLowerCase()
  const modelMax = probeModel()?.max_output ?? 32768
  const cap = raw === 'auto' ? modelMax : (Number(cfg.LLM_MAXTOKENS) || modelMax)
  return Math.min(cap, ctx)
}

/** 把本地大模型接入 Harness：在 profile patch 的 llm-pi-ai 路由里维护 local-llama 这条 OpenAI 协议 config，
 *  并把 agent-default-model 指向它（4.2.2 起本地模型改走 openai-completions 适配器，不再用 llm-deepseek 私有协议）。
 *
 *  0.1.7 起 harness 废弃了 `data\settings.yaml`：启动时 dsh-settings 会把该文件改名成
 *  `settings.yaml.imported` 并把各段迁进 profile 的 patch（= `cordis.patch.yml`），
 *  之后所有配置读写都走 configEditor.documentPath → patchPath。启动器若还往老路径写，
 *  会被 dsh 下次启动再次迁走，形成「写了就没、找不到就 ENOENT」的循环，
 *  dsh-tasks / ml-study 的模型自动切换因此失效（停不掉、也切不回）。
 */
/** 读取 profile patch 里指定 id 的条目（不存在返回 null）。解析失败也返回 null，不抛。 */
export function readProfileEntry(id) {
  const file = profilePatchFile()
  if (yaml === null || !existsSync(file)) return null
  let doc
  try {
    doc = yaml.load(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(doc)) return null
  let target = null
  for (const row of doc) {
    if (row && typeof row === 'object' && row.id === id) target = row
  }
  return target
}

export function syncSettings() {
  const cfg = readConfig()
  const id = modelId()
  const llmPort = Number(cfg.LLM_PORT)
  // A（4.5）：用**实际生效**的上下文，而不是「按当前配置算出来的值」。
  // 服务在跑时两者可能不同（改了配置没重启模型）——那时声明配置值会让 Harness 超出服务器能力。
  const ctx = effectiveCtx()
  const maxTok = resolveMaxTokens(ctx)
  // 视觉能力**按模型**声明（4.5）：只有配了对应投影器（mmproj）的模型才声明图像输入。
  // 声明错代价很大：Harness 会把图片发给看不了图的模型 → 整轮 UNSUPPORTED_CONTENT。

  // llama-server 说的是标准 OpenAI 协议，必须挂在 openai-completions 适配器下。
  // 4.2.2 之前本地模型误配在 llm-deepseek（DeepSeek 私有 Messages 协议）上，
  // 简单回复碰巧能过、但工具调用参数解析一碰就报 "DeepSeek Messages expected a JSON object"。
  // 现改走 llm-pi-ai 路由下的 local-llama（openai-completions），云端 deepseek 路由不动。
  // 4.4：router 模式一次把 models 目录里所有 gguf 都声明给 Harness（配合 --models-dir 热切换）；
  // 单模型模式仍只声明当前 LLM_MODEL 这一个。
  const router = isRouterMode()
  let models
  if (router) {
    // B（4.5）：router 模式下逐模型算上下文（不同体积的模型各拿各的），
    // 与 preset.ini 里的 ctx-size 保持一致。
    models = listGgufNames().map(name => {
      const p = join(DIRS.models, name)
      const mCtx = ctxForModel(p)
      const pMax = probeModel(p)?.max_output ?? 32768
      return {
        id: name.replace(/\.gguf$/i, ''),
        contextWindow: mCtx,
        maxTokens: Math.min(pMax, mCtx),
        ...(mmprojFor(p) !== null ? { inputModalities: ['text', 'image'] } : {}),
      }
    })
  } else {
    models = [
      {
        id,
        contextWindow: ctx,
        maxTokens: maxTok,
        ...(mmprojFor() !== null ? { inputModalities: ['text', 'image'] } : {}),
      },
    ]
  }
  const localLlama = {
    api: 'openai-completions',
    baseURL: `http://${cfg.LLM_HOST}:${llmPort}/v1`,
    apiKeyEnv: 'LLM_API_KEY',
    models,
  }
  // 只更新 local-llama 这一个 provider，云端 deepseek（DEEPSEEK_API_KEY）保持不动。
  // patchProfileEntries 是整段覆盖语义，所以先把现有 providers 读出来再合回去。
  const piConfig = { providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } }
  const existing = readProfileEntry('llm-pi-ai')
  if (existing?.config?.providers && typeof existing.config.providers === 'object') {
    piConfig.providers = { ...existing.config.providers, 'local-llama': localLlama }
  }
  // 默认模型：单模型模式 = 当前文件；router 模式优先用它对应的那个，
  // 不在目录里时退回列表第一个（否则 Harness 会指向一个不存在的模型名）。
  const defaultId = router && !models.some(m => m.id === id) ? (models[0]?.id ?? id) : id
  const selConfig = { provider: 'local-llama', model: defaultId }
  patchProfileEntries([
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: piConfig },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: selConfig },
  ])
}

/** profile patch 文件（cordis.patch.yml）：0.1.7 起 Harness 配置的唯一落盘位置。 */
export function profilePatchFile() {
  return join(DIRS.data, 'profiles', 'web', 'cordis.patch.yml')
}

/** 合并式写入 profile patch：按 id 更新/追加条目并保留其余内容与注释。
 *  用 js-yaml 解析（与 dsh 同款），写回前整份校验，避免写坏 dsh 起不来。
 *  @param {Array<{id: string, name?: string, config: object}>} entries 要同步的条目 */
export function patchProfileEntries(entries) {
  const file = profilePatchFile()
  if (yaml === null) {
    console.warn('[launcher] 取不到 js-yaml（harness 未安装？），跳过配置同步')
    return { ok: false, reason: 'no-yaml' }
  }
  if (!existsSync(file)) {
    // profile 尚未生成：写成裸 settings.yaml 也没用（dsh 会迁走），直接跳过并留下线索。
    console.warn(`[launcher] profile patch 不存在，跳过配置同步：${file}`)
    return { ok: false, reason: 'patch-missing' }
  }
  let doc
  try {
    doc = yaml.load(readFileSync(file, 'utf8'))
  } catch (error) {
    console.warn(`[launcher] profile patch 解析失败，跳过配置同步：${error.message}`)
    return { ok: false, reason: 'parse-failed' }
  }
  if (!Array.isArray(doc)) {
    console.warn('[launcher] profile patch 不是顶层数组，跳过配置同步')
    return { ok: false, reason: 'not-a-list' }
  }
  for (const entry of entries) {
    // Upsert by id：先删掉所有同 id 的旧行，再追加一条（last-wins 语义不变，
    // 顺带在每次同步时清理历史遗留的重复条目——曾累积到 33 条 webserver）。
    doc = doc.filter(row => !(row && typeof row === 'object' && row.id === entry.id))
    doc.push({ id: entry.id, ...(entry.name ? { name: entry.name } : {}), config: entry.config })
  }
  const text = yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' })
  // 自校验：dump 出来的东西必须还能解析回等价结构，否则宁可不写。
  const round = yaml.load(text)
  if (!Array.isArray(round) || round.length !== doc.length) {
    console.warn('[launcher] profile patch 自校验失败，未写入')
    return { ok: false, reason: 'verify-failed' }
  }
  writeFileSync(file, text, 'utf8')
  return { ok: true, count: entries.length }
}


/** 运行外部命令（同步），返回 {ok, stdout, stderr, code}。 */
export function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...options })
  return { ok: r.status === 0, code: r.status ?? r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export function nodeExe() {
  const bundled = join(DIRS.runtimeNode, 'node.exe')
  return existsSync(bundled) ? bundled : 'node'
}

export function npmCli() {
  const bundled = join(DIRS.runtimeNode, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(bundled) ? bundled : null
}

export function pidFile(name) {
  return join(DIRS.logs, `${name}.pid`)
}

export function readPid(name) {
  try {
    const v = readFileSync(pidFile(name), 'utf8').trim()
    return /^\d+$/.test(v) ? Number(v) : null
  } catch { return null }
}

export function writePid(name, pid) {
  mkdirSync(DIRS.logs, { recursive: true })
  writeFileSync(pidFile(name), String(pid), 'ascii')
}

export function clearPid(name) {
  try { writeFileSync(pidFile(name), '', 'ascii') } catch { /* ignore */ }
}

/** 进程是否还活着（services.mjs 里有一份同名私有函数；core 不依赖 services，故各持一份）。 */
function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 本次「实际」启动 llama-server 用的参数（services.mjs 在 spawn 后写 logs\llm-run.json）。
 *  为什么要落盘：配置改了但模型没重启时，配置值 ≠ 服务器实际值。
 *  向 Harness 声明上下文必须用**实际值**——否则 Harness 会往一个服务器给不了的窗口里塞内容，
 *  每个请求都被 llama-server 以 `exceeds the available context size` 拒掉。
 *  （2026-10-03 实际事故：向 Harness 声明 180224、服务器实际 114688 → 本地会话直接卡死。） */
export function runningLlmRun() {
  try {
    const rec = JSON.parse(readFileSync(join(DIRS.logs, 'llm-run.json'), 'utf8'))
    return rec && pidAlive(rec.pid) ? rec : null
  } catch { return null }
}

export function writeLlmRun(rec) {
  try {
    mkdirSync(DIRS.logs, { recursive: true })
    writeFileSync(join(DIRS.logs, 'llm-run.json'), JSON.stringify(rec), 'utf8')
  } catch { /* 落盘失败不影响启动 */ }
}

export function clearLlmRun() {
  try { writeFileSync(join(DIRS.logs, 'llm-run.json'), '', 'utf8') } catch { /* ignore */ }
}

/** 实际生效的上下文：服务在跑 → 用它启动时真正带上的值；没跑 → 按配置 + 显存算。
 *  原则（用户 2026-10-03 拍板）：「按准确的来」——唯一真相是实际运行的东西，
 *  绝不向 Harness 声明一个服务器给不了的窗口。 */
export function effectiveCtx() {
  const ctx = Number(runningLlmRun()?.ctx)
  return Number.isInteger(ctx) && ctx > 0 ? ctx : resolveCtx()
}

export function logPath(name) {
  return join(DIRS.logs, name)
}

/** 读日志尾部 N 行。 */
export function logTail(name, lines = 50) {
  try {
    const content = readFileSync(logPath(name), 'utf8')
    return content.split(/\r?\n/).slice(-lines).join('\n')
  } catch { return '' }
}

export function isWindows() {
  return process.platform === 'win32'
}

export const TASKKILL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')

/** 结束进程树：先 graceful kill，超时后 taskkill /T /F。 */
export async function killProcessTree(pid) {
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ }
  await new Promise(resolve => setTimeout(resolve, 3000))
  try {
    process.kill(pid, 0)
  } catch {
    return // 已退出
  }
  run(TASKKILL, ['/PID', String(pid), '/T', '/F'])
}

/** TCP 端口是否被占用（任意进程）。 */
export function tcpPortBusy(host, port) {
  return new Promise(resolvePort => {
    const socket = net.connect({ host, port, timeout: 600 })
    socket.once('connect', () => { socket.destroy(); resolvePort(true) })
    socket.once('timeout', () => { socket.destroy(); resolvePort(false) })
    socket.once('error', () => resolvePort(false))
  })
}

/** 下一个空闲端口（从 start 起顺延）。 */
export async function freePortAfter(host, start) {
  let port = start
  while (await tcpPortBusy(host, port)) port++
  return port
}

/** 延时。 */
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/** 查询监听指定端口的进程 PID 列表（netstat -ano）。
 *  用于识别「pid 文件已失效但仍占着端口」的孤儿进程（如 agent 自启动的 dsh）。 */
export function portHolderPids(port) {
  const r = run('netstat', ['-ano', '-p', 'TCP'])
  if (!r.ok) return []
  const suffix = `:${port} `
  const pids = new Set()
  for (const line of r.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    // 格式: Proto LocalAddr ForeignAddr State PID
    if (parts.length < 5) continue
    if (parts[3] !== 'LISTENING') continue
    if (!parts[1].endsWith(suffix) && !parts[1].endsWith(`:${port}`)) continue
    if (/^\d+$/.test(parts[4]) && parts[4] !== '0') pids.add(Number(parts[4]))
  }
  return [...pids]
}

/** 等待端口释放；超时返回 false。每轮间隔 intervalMs。 */
export async function waitPortFree(port, timeoutMs = 20000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (portHolderPids(port).length === 0) return true
    await sleep(intervalMs)
  }
  return portHolderPids(port).length === 0
}

/** 列表目录下的 *-backup-* 目录名。 */
export function backupDirs(baseDir) {
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /-backup-/.test(e.name))
      .map(e => e.name)
      .sort()
  } catch { return [] }
}
