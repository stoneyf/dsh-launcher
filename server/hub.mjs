/**
 * 模型广场：代理 Hugging Face 镜像 API（搜索 / 仓库文件列表 / 仓库介绍）。
 * 镜像地址可配置（默认 hf-mirror.com）。
 *
 * 搜索结果的简介（desc）由名称中的参数规模 + tags 派生（HF 搜索接口不带正文）；
 * 选中仓库后 /api/hub/info 提供 README 简介、license 与按本机硬件的下载建议。
 */
import os from 'node:os'
import { readConfig } from './core.mjs'
import { gpuInfo } from './gpu.mjs'

function mirror() {
  return readConfig().HUB_MIRROR.replace(/\/+$/, '') || 'https://hf-mirror.com'
}

async function hubFetch(path, timeoutMs = 20000) {
  const url = `${mirror()}${path}`
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = ''
    try { detail = JSON.parse(await res.text())?.error ?? '' } catch { /* 非 JSON 错误体 */ }
    const error = new Error(`模型广场请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`)
    error.status = res.status
    throw error
  }
  return res.json()
}

// 从仓库名解析参数规模：Qwen3-8B → {total:8}；Qwen3-30B-A3B → {total:30, active:3, moe:true}
function parseSize(name) {
  const n = String(name ?? '').toLowerCase()
  const moe = n.match(/(\d+(?:\.\d+)?)b-a(\d+(?:\.\d+)?)b/)
  if (moe) return { total: Number(moe[1]), active: Number(moe[2]), moe: true }
  const dense = n.match(/(?<!\d)(\d+(?:\.\d+)?)b(?!-a)/)
  if (dense) return { total: Number(dense[1]), moe: false }
  return null
}

const PIPELINE_CN = {
  'text-generation': '文本生成',
  'image-text-to-text': '图像理解',
  'feature-extraction': '特征/嵌入',
  'text-to-speech': '语音合成',
  'automatic-speech-recognition': '语音识别',
  'text-to-image': '图像生成',
  'question-answering': '问答',
  'token-classification': '文本分类',
}

// 由名称参数规模 + tags 派生一句中文简介（HF 搜索接口不带正文描述）
function describe(m) {
  const bits = []
  const size = parseSize(m.modelId ?? m.id ?? '')
  if (size) bits.push(size.moe ? `${size.total}B 参数（MoE 激活 ${size.active}B）` : `${size.total}B 参数`)
  const tags = Array.isArray(m.tags) ? m.tags.join(',') : ''
  const feats = []
  if (m.pipeline_tag) feats.push(PIPELINE_CN[m.pipeline_tag] ?? m.pipeline_tag)
  if (/conversational/.test(tags)) feats.push('对话')
  if (/vision|image-text-to-text|multimodal/.test(tags)) feats.push('视觉')
  if (/gguf/.test(tags)) feats.push('GGUF')
  for (const f of feats) if (!bits.includes(f)) bits.push(f)
  return bits.join(' · ')
}

/** 搜索模型仓库（带派生简介 desc）。 */
export async function hubSearch(query, page = 0, limit = 20) {
  const params = new URLSearchParams({
    search: query,
    limit: String(limit),
    full: 'false',
    sort: 'downloads',
    direction: '-1',
  })
  if (page > 0) params.set('skip', String(page * limit))
  const raw = await hubFetch(`/api/models?${params.toString()}`)
  const allowlistOnly = readConfig().HUB_ALLOWLIST_ONLY === '1'
  const allowlist = ['huihui-ai']
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter(m => (allowlistOnly ? allowlist.some(a => (m.modelId ?? m.id ?? '').toLowerCase().startsWith(a + '/')) : true))
    .map(m => ({
      id: m.modelId ?? m.id ?? m._id ?? '',
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      tag: m.pipeline_tag ?? '',
      desc: describe(m),
      updatedAt: m.lastModified ?? '',
    }))
    .filter(m => m.id !== '')
}

/** 仓库内 GGUF 文件列表（含大小）。 */
export async function hubFiles(repoId) {
  const id = repoId.replace(/\/+/g, '/').trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(id)) {
    const error = new Error('仓库名格式应为 用户名/仓库名')
    error.status = 400
    throw error
  }
  const raw = await hubFetch(`/api/models/${id}/tree/main`)
  const files = Array.isArray(raw) ? raw : []
  return files
    .filter(f => /\.gguf$/i.test(f.path ?? ''))
    .map(f => ({ path: f.path, size: f.size ?? 0 }))
    .sort((a, b) => (a.size ?? 0) - (b.size ?? 0))
}

/** 拼接仓库内文件的下载直链。 */
export function hubFileUrl(repoId, filePath) {
  return `${mirror()}/${repoId}/resolve/main/${encodeURIComponent(filePath)}`
}

// 从 README 原文提取纯文本简介（去 frontmatter / HTML 标签 / markdown 记号，取前 400 字）
function introFromReadme(raw) {
  if (!raw) return ''
  let t = String(raw)
  t = t.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, ' ')
  t = t.replace(/<[^>]+>/g, ' ')
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/^#{1,6}\s+/gm, '')
  t = t.replace(/[*_`>#|]/g, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > 400 ? t.slice(0, 400) + '……' : t
}

/** 仓库介绍：README 简介 + license（来自 cardData）。任一失败不影响另一项。 */
export async function hubInfo(repoId) {
  const id = repoId.replace(/\/+/g, '/').trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(id)) {
    const error = new Error('仓库名格式应为 用户名/仓库名')
    error.status = 400
    throw error
  }
  const [metaRes, readmeRes] = await Promise.allSettled([
    hubFetch(`/api/models/${id}`),
    fetch(`${mirror()}/${id}/resolve/main/README.md`, { signal: AbortSignal.timeout(15000) }).then(r => (r.ok ? r.text() : '')),
  ])
  const meta = metaRes.status === 'fulfilled' ? metaRes.value : null
  let license = ''
  try { license = meta?.cardData?.license ?? '' } catch { /* 无 */ }
  let intro = ''
  if (readmeRes.status === 'fulfilled' && readmeRes.value) {
    intro = introFromReadme(readmeRes.value)
  }
  if (!intro) {
    // README 缺失时用仓库名 + 参数规模兜底
    const size = parseSize(id)
    intro = size ? `该仓库为 ${size.total}B 参数模型${size.moe ? `（MoE，激活 ${size.active}B）` : ''}。` : ''
  }
  return { id, intro, license }
}

// GGUF 文件名 → 量化标识（Q4_K_M / Q8_0 / F16 / IQ4_XS …）
function quantOf(name) {
  return (String(name).match(/(?:Q[2-8](?:_[A-Z0-9]+)?|IQ\d_[A-Z0-9]+|F16|BF16)/i) ?? [])[0] ?? ''
}

/**
 * 按本机硬件（内存 / NVIDIA 显存）对仓库内 GGUF 文件逐一评级，
 * 并给出推荐下载的文件与一句话建议。
 * 评级：
 *   gpu     权重+上下文可全量放入显存
 *   hybrid  显存放不下，但 GPU+CPU 混合卸载可行
 *   ok      无独显（或 CPU 场景）内存宽裕
 *   tight   内存较紧张，需关闭其他大程序
 *   over    超出本机内存
 */
export async function hubRecommend(files) {
  const list = Array.isArray(files) ? files : []
  if (list.length === 0) return { text: '', recommendedPath: null, levels: {}, hardware: null }
  const gpu = await gpuInfo()
  const ramMiB = os.totalmem() / 1048576
  const vramMiB = gpu.available && gpu.totalMiB ? Number(gpu.totalMiB) : 0
  const levels = {}
  for (const f of list) {
    const sizeMiB = (f.size ?? 0) / 1048576
    const needMiB = sizeMiB * 1.1 + 1536 // 权重 + 上下文/激活开销估算
    let level
    if (vramMiB > 0) {
      if (needMiB <= vramMiB * 0.9) level = 'gpu'
      else if (needMiB <= vramMiB * 0.9 + ramMiB * 0.5) level = 'hybrid'
      else level = 'over'
    } else {
      if (needMiB <= ramMiB * 0.7) level = 'ok'
      else if (needMiB <= ramMiB * 0.9) level = 'tight'
      else level = 'over'
    }
    levels[f.path] = level
  }
  const bySize = [...list].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
  const pick = ls => bySize.find(f => ls.includes(levels[f.path])) ?? null
  const best = pick(['gpu', 'ok']) ?? pick(['hybrid', 'tight'])
  const hwBits = [`${Math.round(ramMiB / 1024)}GB 内存`]
  if (vramMiB > 0) hwBits.push(`${gpu.name ?? 'NVIDIA GPU'} ${Math.round(vramMiB / 1024)}GB 显存`)
  else hwBits.push('无 NVIDIA 独显（CPU 推理）')
  const hardware = { ramGiB: Math.round(ramMiB / 1024), gpu: vramMiB > 0 ? `${gpu.name} ${Math.round(vramMiB / 1024)}GB` : null }
  let text
  if (!best) {
    text = `本机 ${hwBits.join(' + ')}：该仓库最小量化也已超出内存，建议换更小的模型或更低量化。`
  } else {
    const base = String(best.path).split(/[\\/]/).pop()
    const gb = ((best.size ?? 0) / 1073741824).toFixed(1)
    const adv = {
      gpu: '可全量装入显存，体验最佳',
      hybrid: '显存放不下，GPU+CPU 混合卸载可用',
      ok: 'CPU 推理内存宽裕',
      tight: '内存较紧张，建议关闭其他大程序',
    }[levels[best.path]] ?? ''
    text = `本机 ${hwBits.join(' + ')}：建议下载 ${base}（约 ${gb}GB，${adv}）。`
  }
  return { text, recommendedPath: best?.path ?? null, levels, hardware }
}
