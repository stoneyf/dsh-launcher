/* DSH 启动器 V3 前端应用（无构建、零依赖） */
/* V3：重启按钮 + 阶段进度（SSE /api/services/events 即时推送 + 4s 状态轮询兜底） */
'use strict'

const token = new URLSearchParams(location.search).get('token') ?? ''
const $ = sel => document.querySelector(sel)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let status = null
let activeLogTab = 'llm'
let logSource = null
let updateBusy = false
const downloadBars = new Map() // fileName -> {outer, inner, label}
const downloadSpeed = new Map() // fileName -> {lastBytes, lastTs, speed}

// ---------- 模型广场状态 ----------
let hubResults = []      // 当前查询的累积结果
let hubPage = 0          // 已加载到的页码
let hubHasMore = true
let hubEverSearched = false
let hubRepoFiles = []    // 当前仓库的文件列表
let hubRepo = ''         // 当前查看的仓库 id

// ---------- 主题 ----------
function applyTheme(theme) {
  let actual = theme
  if (theme === 'system') actual = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', actual)
  try { localStorage.setItem('dsh-theme', theme) } catch { /* 忽略 */ }
}
function bindTheme() {
  const sel = $('#theme-select')
  if (!sel) return
  const sync = () => { applyTheme(sel.value); if (sel.value === 'system') applyTheme('system') }
  sel.addEventListener('change', async () => {
    applyTheme(sel.value)
    const msg = $('#theme-msg')
    try {
      await api('PUT', '/api/config', { THEME: sel.value })
      msg.textContent = '已保存 ✓'; msg.className = 'msg ok'
    } catch (e) { msg.textContent = `保存失败：${e.message}`; msg.className = 'msg err' }
  })
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (sel.value === 'system') applyTheme('system')
  })
  return sel
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data
}

function fmtBytes(n) {
  if (n === null || n === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}
const fmtDownloads = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n ?? 0)
const quantOf = name => (name.match(/(?:Q[2-8](?:_[A-Z0-9]+)?|IQ\d_[A-Z0-9]+|F16|BF16)/i) ?? [])[0] ?? ''

function notice(text, isError = false) {
  const box = $('#home-notice')
  box.textContent = text
  box.classList.remove('hidden', 'error')
  if (isError) box.classList.add('error')
  if (text) box.classList.remove('hidden')
}

function setBadge(el, on, text) {
  el.textContent = text
  el.classList.toggle('on', Boolean(on))
  el.classList.toggle('off', !on)
}

// ---------- V3：重启进度 ----------
const RESTART_INPROGRESS = ['stopping', 'killing-port-holder', 'waiting-port', 'starting', 'loading']
const RESTART_LABELS = {
  stopping: '正在停止……',
  'killing-port-holder': '查杀孤儿进程……',
  'waiting-port': '等待端口释放……',
  starting: '正在启动……',
  loading: '正在加载模型……',
  ready: '✓ 已就绪',
  error: '✗ 重启失败',
}

function renderRestartProgress(svc, info, progressEl, btnRestart, btnStart, btnStop) {
  const phase = info?.phase
  const label = phase ? RESTART_LABELS[phase] ?? '' : ''
  if (phase && label) {
    progressEl.textContent = (info.detail && phase !== 'ready') ? `${label} ${info.detail}` : label
    progressEl.classList.remove('hidden')
    progressEl.classList.toggle('error', phase === 'error')
  } else {
    progressEl.classList.add('hidden')
    progressEl.classList.remove('error')
  }
  const busy = phase ? RESTART_INPROGRESS.includes(phase) : false
  for (const b of [btnRestart, btnStart, btnStop]) b.disabled = busy
}

// ---------- 状态轮询 ----------
async function refreshStatus() {
  try {
    status = await api('GET', '/api/status')
    renderHome()
    renderMaintain()
    if (!status.services.llm.running && !status.services.dsh.running) {
      $('#mini-status').textContent = '服务未运行'
    } else {
      const parts = []
      if (status.services.llm.running) parts.push(status.services.llm.health ? '模型 ✓' : '模型加载中')
      if (status.services.dsh.running) parts.push('Harness ✓')
      $('#mini-status').textContent = parts.join(' · ') || '—'
    }
  } catch (error) {
    $('#mini-status').textContent = '后端不可用'
  }
}

// ---------- 主页 ----------
function renderHome() {
  if (!status) return
  const { llm, dsh } = status.services
  setBadge($('#badge-llm'), llm.running, llm.running ? '运行中' : '未运行')
  $('#llm-model').textContent = llm.model
  $('#llm-endpoint').textContent = llm.endpoint
  $('#llm-health').textContent = llm.running ? (llm.health ? '模型已加载 ✓' : '加载中/不可用') : '—'
  setBadge($('#badge-dsh'), dsh.running, dsh.running ? '运行中' : '未运行')
  $('#dsh-url').textContent = dsh.url ?? '—'
  $('#dsh-health').textContent = dsh.running ? '服务监听中' : '—'
  const rr = status.restarting ?? {}
  renderRestartProgress('llm', rr.llm, $('#llm-restart-progress'), $('#btn-llm-restart'), $('#btn-llm-start'), $('#btn-llm-stop'))
  renderRestartProgress('dsh', rr.dsh, $('#dsh-restart-progress'), $('#btn-dsh-restart'), $('#btn-dsh-start'), $('#btn-dsh-stop'))
  const gpu = status.gpu
  if (gpu?.available) {
    $('#gpu-name').textContent = gpu.name
    $('#gpu-driver').textContent = gpu.driver
    const used = gpu.totalMiB - gpu.freeMiB
    $('#gpu-bar').style.width = `${Math.min(100, used / gpu.totalMiB * 100)}%`
    $('#gpu-free').textContent = `${(gpu.freeMiB / 1024).toFixed(1)}GB`
    $('#gpu-used').textContent = `${(used / 1024).toFixed(1)}GB`
    $('#gpu-total').textContent = `${(gpu.totalMiB / 1024).toFixed(1)}GB`
  } else {
    $('#gpu-name').textContent = '未检测到 NVIDIA 显卡'
    $('#gpu-driver').textContent = '—'
  }
  const v = status.versions
  $('#ver-launcher').textContent = v.launcher ?? '—'
  $('#ver-dsh').textContent = v.harness.current
  $('#ver-llama').textContent = v.llama.current
  $('#ver-node').textContent = v.node.current
  if (status.config?.THEME) {
    const sel = $('#theme-select')
    if (sel && sel.value !== status.config.THEME) { sel.value = status.config.THEME; applyTheme(sel.value) }
  }
  if (status.disk) {
    $('#disk-free').textContent = fmtBytes(status.disk.free)
    $('#disk-total').textContent = fmtBytes(status.disk.total)
  }
  $('#btn-start-all').disabled = false
  // 首启引导：无模型或服务未启动时提示步骤
  const activeModel = status.models.find(m => m.active)
  const servicesOff = !status.services.llm.running && !status.services.dsh.running
  const onboard = $('#home-onboard')
  if (!activeModel || servicesOff) {
    const steps = []
    if (!activeModel) steps.push('① 到「模型」页下载或导入本地模型')
    if (servicesOff) steps.push('② 点击下方「一键启动」')
    onboard.querySelector('.onboard-steps').textContent = steps.join('　')
    onboard.classList.remove('hidden')
  } else {
    onboard.classList.add('hidden')
  }
}

function goPage(name) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === name))
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`))
  if (name === 'models') {
    loadInstalled(); renderPresets()
    if (!hubEverSearched) hubSearch()
  }
  if (name === 'settings') loadSettings()
}

async function startAll() {
  $('#btn-start-all').disabled = true
  $('#btn-start-all').textContent = '启动中……'
  notice('正在启动本地大模型与 Harness，模型加载可能需要一两分钟……')
  try {
    const r = await api('POST', '/api/start-all')
    const errors = []
    if (r.llm?.error) errors.push(`大模型：${r.llm.error}`)
    if (r.dsh?.error) errors.push(`Harness：${r.dsh.error}`)
    if (errors.length) notice(errors.join('；'), true)
    else notice('全部服务已启动 ✓')
  } catch (error) {
    notice(`启动失败：${error.message}`, true)
  }
  $('#btn-start-all').textContent = '▶ 一键启动'
  await refreshStatus()
}

async function stopAll() {
  notice('正在停止全部服务……')
  try {
    await api('POST', '/api/stop-all')
    notice('已停止全部服务')
  } catch (error) {
    notice(`停止失败：${error.message}`, true)
  }
  await refreshStatus()
}

// V3：重启 —— API 立即 202 返回，进度由 SSE 即时推送 + 状态轮询兜底
async function restartService(svc) {
  const label = svc === 'dsh' ? 'Harness' : '本地大模型'
  notice(`正在重启${label}……浏览器会话会短暂断开后自动重连`)
  try {
    await api('POST', `/api/services/${svc}/restart`)
  } catch (error) {
    notice(`重启失败：${error.message}`, true)
  }
  await refreshStatus()
}

// ---------- 模型页 ----------
async function loadInstalled() {
  try {
    const models = await api('GET', '/api/models')
    const box = $('#installed-list')
    if (models.length === 0) {
      box.innerHTML = '<div class="notice">还没有安装模型，去模型广场下载或导入本地 GGUF。</div>'
      return
    }
    box.innerHTML = ''
    for (const m of models) {
      const card = document.createElement('div')
      card.className = `model-card${m.active ? ' active' : ''}`
      const quant = quantOf(m.name)
      card.innerHTML = `
        <div class="model-name">${esc(m.name)}</div>
        <div class="model-meta">
          ${quant ? `<span class="quant-tag">${esc(quant)}</span>` : ''}
          <span>${fmtBytes(m.size)}</span>
          ${m.active ? '<span class="active-tag">当前使用</span>' : ''}
        </div>
        <div class="model-actions">
          ${m.active ? '' : `<button class="btn btn-sm" data-act="switch" data-name="${esc(m.name)}">设为当前</button>`}
          <button class="btn btn-sm btn-danger-ghost" data-act="delete" data-name="${esc(m.name)}">删除</button>
        </div>`
      card.addEventListener('click', async e => {
        const btn = e.target.closest('button')
        if (!btn) return
        const name = btn.dataset.name
        try {
          if (btn.dataset.act === 'switch') {
            await api('POST', '/api/models/switch', { name })
            await refreshStatus()
            await loadInstalled()
          } else if (btn.dataset.act === 'delete') {
            if (!confirm(`确认删除模型 ${name}？（不可恢复）`)) return
            await api('DELETE', `/api/models/${encodeURIComponent(name)}`)
            await refreshStatus()
            await loadInstalled()
          }
        } catch (error) {
          notice(`操作失败：${error.message}`, true)
        }
      })
      box.appendChild(card)
    }
  } catch (error) {
    $('#installed-list').innerHTML = `<div class="notice error">${esc(error.message)}</div>`
  }
}

function renderPresets() {
  const presets = [
    { label: 'Huihui-Qwen3.8-27B Q4_K（16.8GB，推荐）', url: 'https://hf-mirror.com/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/resolve/main/Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf' },
    { label: 'Q3_K（13.5GB）', url: 'https://hf-mirror.com/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/resolve/main/Huihui-Qwen3.8-27B-abliterated-Q3_K.gguf' },
    { label: 'Q6_K（22.4GB）', url: 'https://hf-mirror.com/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/resolve/main/Huihui-Qwen3.8-27B-abliterated-Q6_K.gguf' },
  ]
  const row = $('#preset-row')
  row.innerHTML = ''
  for (const p of presets) {
    const btn = document.createElement('button')
    btn.className = 'btn btn-sm'
    btn.textContent = p.label
    btn.addEventListener('click', () => startDownload(p.url, null, '模型下载'))
    row.appendChild(btn)
  }
}

async function startDownload(url, dest, label) {
  try {
    const task = await api('POST', '/api/downloads', { url, dest, label })
    const panel = $('#hub-files')
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden')
      $('#hub-files-title').textContent = '下载任务'
    }
    ensureDownloadBar(task.fileName, task.id, task.url, task.label)
    notice(`已开始下载：${task.fileName}`, false)
  } catch (error) {
    notice(`下载失败：${error.message}`, true)
  }
}

function ensureDownloadBar(fileName, id, url, label = 'download') {
  const container = $('#hub-files-list')
  let bar = downloadBars.get(fileName)
  if (bar) {
    bar.taskId = id
    bar.url = url
    bar.label = label
    return
  }
  const outer = document.createElement('div')
  outer.className = 'hub-file'
  outer.innerHTML = `
    <span class="name">${esc(fileName)}</span>
    <span class="size">准备中</span>
    <button class="btn btn-xs dl-action">取消</button>
    <div class="progress-outer"><div class="progress-inner"></div></div>`
  container.appendChild(outer)
  bar = { outer, inner: outer.querySelector('.progress-inner'), sizeEl: outer.querySelector('.size'), action: outer.querySelector('.dl-action'), taskId: id, url, label }
  downloadBars.set(fileName, bar)
  bar.action.addEventListener('click', async () => {
    if (bar.action.dataset.act === 'cancel') {
      if (bar.taskId) await api('POST', `/api/downloads/${encodeURIComponent(bar.taskId)}/cancel`)
    } else if (bar.action.dataset.act === 'resume') {
      const task = await api('POST', '/api/downloads', { url: bar.url, label: bar.label })
      bar.taskId = task.id
      bar.inner.style.width = '4%'
      bar.action.textContent = '取消'
      bar.action.dataset.act = 'cancel'
    }
  })
}

function onDownloadTask(task) {
  const bar = [...downloadBars.values()].find(b => b.taskId === task.id)
  if (!bar) return
  const pct = task.total ? Math.round(task.downloaded / task.total * 100) : 0
  bar.inner.style.width = `${task.total ? pct : 4}%`
  if (task.state === 'running') {
    // 速度/ETA：按事件间隔估算
    const now = Date.now()
    const prev = downloadSpeed.get(task.fileName) || { lastBytes: task.downloaded, lastTs: now, speed: 0 }
    const dt = (now - prev.lastTs) / 1000
    if (dt >= 0.5 && task.downloaded >= prev.lastBytes) {
      prev.speed = (task.downloaded - prev.lastBytes) / dt
    }
    prev.lastBytes = task.downloaded
    prev.lastTs = now
    downloadSpeed.set(task.fileName, prev)
    const speedTxt = prev.speed > 0 ? ` · ${(prev.speed / 1e6).toFixed(1)} MB/s` : ''
    const remainTxt = task.total && prev.speed > 0 ? ` · 剩余 ${Math.ceil((task.total - task.downloaded) / prev.speed / 60)} 分钟` : ''
    bar.action.textContent = '取消'
    bar.action.dataset.act = 'cancel'
    bar.sizeEl.textContent = task.total ? `${fmtBytes(task.downloaded)} / ${fmtBytes(task.total)} (${pct}%${speedTxt}${remainTxt})` : `${fmtBytes(task.downloaded)}${speedTxt}`
  } else if (task.state === 'done') {
    bar.sizeEl.textContent = '完成 ✓'
    bar.inner.style.width = '100%'
    bar.action.style.display = 'none'
    setTimeout(async () => { await loadInstalled() }, 800)
  } else if (task.state === 'cancelled') {
    bar.sizeEl.textContent = `已取消（${fmtBytes(task.downloaded)}）`
    bar.action.textContent = '续传'
    bar.action.dataset.act = 'resume'
    bar.action.style.display = ''
  } else {
    bar.sizeEl.textContent = `失败：${task.error ?? ''}`
    bar.action.textContent = '重试'
    bar.action.dataset.act = 'resume'
    bar.action.style.display = ''
  }
}

// ---------- 模型广场：搜索历史 + 分页 ----------
function hubHistory() {
  try { return JSON.parse(localStorage.getItem('dsh-hub-history') || '[]') } catch { return [] }
}
function rememberHubQuery(q) {
  if (!q) return
  let h = hubHistory().filter(x => x !== q)
  h.unshift(q)
  try { localStorage.setItem('dsh-hub-history', JSON.stringify(h.slice(0, 8))) } catch { /* 忽略 */ }
  renderHubHistory()
}
function renderHubHistory() {
  const box = $('#hub-history')
  if (!box) return
  const h = hubHistory()
  box.innerHTML = h.map(q => `<span class="hub-chip" data-q="${esc(q)}">${esc(q)}</span>`).join('')
  for (const chip of box.querySelectorAll('.hub-chip')) {
    chip.addEventListener('click', () => { $('#hub-query').value = chip.dataset.q; hubSearch(true) })
  }
}
function hubMirrorUrl(suffix = '') {
  const mirror = (status?.config?.HUB_MIRROR ?? 'https://hf-mirror.com').replace(/\/+$/, '')
  return suffix ? `${mirror}/${suffix}` : mirror
}

async function hubSearch(reset = true) {
  const q = $('#hub-query').value.trim()
  const box = $('#hub-results')
  const more = $('#btn-hub-more')
  if (!q) return
  if (reset) {
    hubResults = []
    hubPage = 0
    hubHasMore = true
    box.innerHTML = '<div class="notice">搜索中……</div>'
  }
  more.classList.add('hidden')
  $('#btn-hub-search').disabled = true
  try {
    const list = await api('GET', `/api/hub/search?q=${encodeURIComponent(q)}&page=${hubPage}`)
    if (reset) rememberHubQuery(q)
    if (hubPage === 0 && list.length === 0) {
      box.innerHTML = '<div class="notice">没有结果</div>'
      hubEverSearched = true
      return
    }
    hubResults.push(...list)
    renderHubResults()
    hubHasMore = list.length >= 20
    if (hubHasMore) { hubPage += 1; more.classList.remove('hidden') }
    hubEverSearched = true
  } catch (error) {
    if (hubPage === 0) box.innerHTML = `<div class="notice error">${esc(error.message)}</div>`
    else notice(`加载失败：${error.message}`, true)
  }
  $('#btn-hub-search').disabled = false
}

function renderHubResults() {
  const box = $('#hub-results')
  box.innerHTML = ''
  for (const repo of hubResults) {
    const div = document.createElement('div')
    div.className = 'hub-repo'
    const desc = repo.desc || repo.tag || '模型'
    div.innerHTML = `
      <span class="id">${esc(repo.id)}${repo.likes ? ` <span class="meta">♥ ${fmtDownloads(repo.likes)}</span>` : ''}</span>
      <span class="meta">${esc(desc)} · 下载 ${fmtDownloads(repo.downloads)} · <a href="${esc(hubMirrorUrl(repo.id))}" target="_blank" rel="noopener" class="hub-open">打开 ↗</a></span>`
    div.addEventListener('click', ev => {
      if (ev.target.closest('a')) return
      showHubFiles(repo.id)
    })
    box.appendChild(div)
  }
}

let hubRecommend = null   // 当前仓库的硬件建议 {text, recommendedPath, levels}
let hubModelInfo = null   // 当前仓库介绍 {intro, license}

async function showHubFiles(repoId) {
  const panel = $('#hub-files')
  const list = $('#hub-files-list')
  const infoBox = $('#hub-model-info')
  hubRepo = repoId
  hubRecommend = null
  hubModelInfo = null
  $('#hub-files-title').textContent = repoId
  $('#hub-file-filter').value = ''
  panel.classList.remove('hidden')
  list.innerHTML = '<div class="notice">加载中……</div>'
  infoBox.innerHTML = '<div class="notice">正在获取仓库介绍与本机硬件建议……</div>'
  try {
    const [fileResp, info] = await Promise.all([
      api('GET', `/api/hub/files/${encodeURIComponent(repoId)}`),
      api('GET', `/api/hub/info/${encodeURIComponent(repoId)}`).catch(() => null),
    ])
    hubRepoFiles = Array.isArray(fileResp?.files) ? fileResp.files : []
    hubRecommend = fileResp?.recommend ?? null
    hubModelInfo = info
    infoBox.innerHTML = renderHubModelInfo(info)
    renderHubFiles(repoId)
  } catch (error) {
    list.innerHTML = `<div class="notice error">${esc(error.message)}</div>`
    infoBox.innerHTML = ''
  }
}

const HUB_LEVEL_CN = {
  gpu: '可上显存',
  hybrid: 'GPU+CPU 混合',
  ok: '内存宽裕',
  tight: '内存紧张',
  over: '超出内存',
}

function renderHubModelInfo(info) {
  if (!info && !hubRecommend) return ''
  const parts = []
  if (info?.intro) parts.push(`<p class="hub-intro">${esc(info.intro)}</p>`)
  if (info?.license) parts.push(`<span class="hub-license">许可：${esc(info.license)}</span>`)
  if (hubRecommend?.text) {
    parts.push(`<div class="hub-recommend">💡 ${esc(hubRecommend.text)}</div>`)
  }
  return parts.join('')
}

function renderHubFiles(repoId) {
  const list = $('#hub-files-list')
  const filter = ($('#hub-file-filter')?.value ?? '').trim().toLowerCase()
  const sort = $('#hub-file-sort')?.value ?? 'size-asc'
  let files = [...hubRepoFiles]
  if (filter) files = files.filter(f => f.path.toLowerCase().includes(filter))
  if (sort === 'size-desc') files.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
  else if (sort === 'name') files.sort((a, b) => a.path.localeCompare(b.path))
  else files.sort((a, b) => (a.size ?? 0) - (b.size ?? 0))
  list.innerHTML = ''
  if (files.length === 0) {
    list.innerHTML = '<div class="notice">该仓库没有 GGUF 文件（或筛选无结果）</div>'
    return
  }
  const installed = new Set((status?.models ?? []).map(m => m.name))
  const rec = hubRecommend ?? null
  for (const f of files) {
    const base = f.path.split(/[\\/]/).pop()
    const has = installed.has(base)
    const isRec = rec?.recommendedPath === f.path
    const level = rec?.levels?.[f.path] ?? ''
    const row = document.createElement('div')
    row.className = 'hub-file'
    row.innerHTML = `
      <span class="name">${esc(base)} <span class="quant-tag">${esc(quantOf(base))}</span>${isRec ? ' <span class="rec-tag">推荐</span>' : ''}${level && !isRec ? ` <span class="level-tag">${esc(HUB_LEVEL_CN[level] ?? '')}</span>` : ''}${has ? ' <span class="active-tag">已安装</span>' : ''}</span>
      <span class="size">${fmtBytes(f.size)}</span>
      <a class="btn btn-ghost btn-xs hub-open" href="${esc(hubMirrorUrl(`${repoId}/resolve/main/${encodeURIComponent(f.path)}`))}" target="_blank" rel="noopener">直链</a>
      <button class="btn btn-sm btn-primary" data-path="${esc(f.path)}" ${has ? 'disabled' : ''}>${has ? '已安装' : '下载'}</button>`
    row.querySelector('button').addEventListener('click', () =>
      startDownload(hubMirrorUrl(`${repoId}/resolve/main/${encodeURIComponent(f.path)}`), null, '模型下载'))
    list.appendChild(row)
  }
}

// ---------- 模型测试（多轮对话） ----------
let chatHistory = [] // [{role:'user'|'assistant', content}]
function appendBubble(role, text) {
  const log = $('#chat-log')
  const div = document.createElement('div')
  div.className = `chat-bubble ${role}`
  div.textContent = text
  log.appendChild(div)
  log.scrollTop = log.scrollHeight
  return div
}

function clearChat() {
  chatHistory = []
  $('#chat-log').innerHTML = ''
  $('#chat-stats').textContent = ''
}

async function sendChat() {
  const input = $('#chat-input')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  $('#btn-chat-send').disabled = true
  $('#chat-stats').textContent = ''
  appendBubble('user', text)
  chatHistory.push({ role: 'user', content: text })
  const bubble = appendBubble('assistant', '')
  let content = ''
  let reasoning = ''
  try {
    const res = await fetch(`/api/chat/test?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: chatHistory,
        maxTokens: Number($('#chat-maxtokens').value) || 2048,
        temperature: Number($('#chat-temp').value ?? 0.7),
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error ?? `HTTP ${res.status}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let lastEvent = ''
    const handleEvent = (evt, data) => {
      if (evt === 'delta') { content += data.text; bubble.textContent = content; bubble.scrollIntoView({ block: 'end' }) }
      else if (evt === 'reasoning') reasoning += data.text
      else if (evt === 'done') {
        lastEvent = JSON.stringify(data)
        const bits = []
        if (data.usage?.completion_tokens) bits.push(`${data.usage.completion_tokens} tokens`)
        if (data.usage?.prompt_tokens) bits.push(`提示 ${data.usage.prompt_tokens} tokens`)
        if (data.tokensPerSec) bits.push(`${data.tokensPerSec} tok/s`)
        if (data.elapsedSec) bits.push(`${data.elapsedSec}s`)
        $('#chat-stats').textContent = bits.join(' · ')
      }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      let pendingEvent = null
      for (const line of lines) {
        if (line.startsWith('event:')) pendingEvent = line.slice(6).trim()
        else if (line.startsWith('data:')) {
          try { handleEvent(pendingEvent, JSON.parse(line.slice(5).trim())) } catch { /* 忽略 */ }
          pendingEvent = null
        }
      }
    }
    if (reasoning) {
      const details = document.createElement('details')
      details.innerHTML = `<summary>思考过程（${reasoning.length} 字）</summary><div class="thinking">${esc(reasoning)}</div>`
      bubble.appendChild(details)
    }
    if (!content) {
      bubble.textContent = '（模型未输出内容）'
      chatHistory.pop() // 移除无效的这轮用户输入，避免污染上下文
    } else {
      chatHistory.push({ role: 'assistant', content })
    }
  } catch (error) {
    bubble.textContent = `请求失败：${error.message}`
    chatHistory.pop()
  }
  $('#btn-chat-send').disabled = false
}

// ---------- 设置 ----------
async function loadSettings() {
  const cfg = status?.config ?? await api('GET', '/api/config')
  const form = $('#settings-form')
  for (const el of form.elements) {
    if (!el.name) continue
    const value = cfg[el.name] ?? ''
    if (el.type === 'checkbox') el.checked = value === '1' || value === true
    else if (el.tagName === 'SELECT') {
      el.value = value
      if (el.selectedIndex < 0) el.selectedIndex = 0  // 值不在选项里时回落第一项
    } else el.value = value
  }
  $('#hub-allowlist').checked = cfg.HUB_ALLOWLIST_ONLY === '1'
  updateLlmHints()
  if (!form.dataset.llmHintsBound) {
    form.dataset.llmHintsBound = '1'
    form.querySelector('[name=LLM_CTX]')?.addEventListener('change', updateLlmHints)
    form.querySelector('[name=LLM_MAXTOKENS]')?.addEventListener('change', updateLlmHints)
  }
}

/** "自动"时按实际解析值给出提示：上下文按显存、最大输出取模型上限（都不超上下文）。 */
function updateLlmHints() {
  const llm = status?.llm
  const fmtK = n => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))
  const form = $('#settings-form')
  const ctxSel = form?.querySelector('[name=LLM_CTX]')
  const tokSel = form?.querySelector('[name=LLM_MAXTOKENS]')
  if (!ctxSel || !tokSel) return
  const ctxHint = $('#ctx-hint')
  const tokHint = $('#maxtok-hint')
  const modelMax = llm?.modelMaxOutput ?? 32768
  const modelNative = llm?.modelNativeContext ?? null
  // 上下文：auto 用后端解析值，否则用所选值
  const ctx = (ctxSel.value === 'auto') ? (llm?.ctx ?? null) : (Number(ctxSel.value) || null)
  // 最大输出：auto 用模型上限，否则用所选值；最终都不超过上下文
  const cap = (tokSel.value === 'auto') ? modelMax : (Number(tokSel.value) || modelMax)
  const maxTok = (ctx != null) ? Math.min(cap, ctx) : cap
  if (ctxHint) {
    ctxHint.innerHTML = (ctx != null)
      ? (ctxSel.value === 'auto'
          ? `实际 <b>${fmtK(ctx)}</b>${modelNative ? ` · 模型上限 ${fmtK(modelNative)}` : ''}（按显存自动）`
          : `实际 <b>${fmtK(ctx)}</b>`)
      : ''
  }
  if (tokHint) {
    tokHint.innerHTML = (maxTok != null)
      ? (tokSel.value === 'auto'
          ? `实际 <b>${fmtK(maxTok)}</b>（模型上限 ${fmtK(modelMax)}${(ctx != null && maxTok < modelMax) ? `，受上下文 ${fmtK(ctx)} 限制` : ''}）`
          : `实际 <b>${fmtK(maxTok)}</b>${(ctx != null && maxTok < cap) ? `（受上下文 ${fmtK(ctx)} 限制）` : ''}`)
      : ''
  }
}

// ---------- 维护 ----------
function renderMaintain() {
  if (!status) return
  const diag = []
  const add = (name, state, hint) => diag.push({ name, state, hint })
  const v = status.versions
  add('内置 Node 运行时', v.node.current !== '未安装' ? 'ok' : 'bad', v.node.current)
  add('llama.cpp（llama-server）', v.llama.current !== '未安装' ? 'ok' : 'bad', v.llama.current)
  add('Harness (dsh)', v.harness.current !== '未安装' ? 'ok' : 'bad', v.harness.current)
  if (status.gpu?.available) {
    add('NVIDIA GPU', 'ok', `${status.gpu.name} · 空闲 ${(status.gpu.freeMiB / 1024).toFixed(1)}GB`)
    add('显存余量', status.gpu.freeMiB > 4096 ? 'ok' : 'warn', `空闲 ${(status.gpu.freeMiB / 1024).toFixed(1)}GB${status.gpu.freeMiB <= 4096 ? '，偏紧，建议降低 LLM_CTX' : ''}`)
  } else {
    add('NVIDIA GPU', 'warn', '未检测到 NVIDIA 显卡（CPU 推理可用但较慢）')
  }
  const activeModel = status.models.find(m => m.active)
  add('当前模型文件', activeModel ? 'ok' : 'bad', activeModel ? `${activeModel.name}（${fmtBytes(activeModel.size)}）` : '未安装，请到模型页下载')
  add('LLM 端口 8080', status.ports.llm && !status.services.llm.running ? 'warn' : 'ok', status.ports.llm && !status.services.llm.running ? '被其他程序占用，请在设置中更换 LLM_PORT' : status.ports.llm ? '本地大模型监听中' : '空闲')
  add('Harness 端口', status.ports.dsh && !status.services.dsh.running ? 'warn' : 'ok', status.ports.dsh && !status.services.dsh.running ? '被占用（启动时自动顺延）' : status.ports.dsh ? '监听中' : '空闲')
  add('磁盘空间', status.disk && status.disk.free > 20 * 1024 ** 3 ? 'ok' : 'warn', status.disk ? `剩余 ${fmtBytes(status.disk.free)}` : '未知')
  const box = $('#diag-list')
  box.innerHTML = ''
  for (const item of diag) {
    const row = document.createElement('div')
    row.className = 'diag-item'
    const label = { ok: '✓', bad: '✗', warn: '!' }[item.state] ?? '—'
    row.innerHTML = `<span>${label} ${esc(item.name)}</span><span class="state ${item.state}">${label}</span><span class="hint">${esc(item.hint)}</span>`
    box.appendChild(row)
  }
  // 版本表
  const table = $('#version-table')
  table.innerHTML = ''
  const comps = [
    { key: 'harness', name: 'Harness (dsh)' },
    { key: 'llama', name: 'llama.cpp' },
    { key: 'node', name: '内置 Node' },
  ]
  for (const c of comps) {
    const info = v[c.key]
    const latest = info.latest ?? (info.checkedAt ? '查询失败' : '未检查')
    const noUpdate = info.updateAvailable === false
    const row = document.createElement('div')
    row.className = 'version-row'
    row.innerHTML = `
      <span class="name">${esc(c.name)}</span>
      <span class="ver">当前 <b>${esc(info.current)}</b> · 最新 ${esc(latest)}${info.channel ? `（${esc(info.channel)}）` : ''}${noUpdate ? ' · <span class="muted">已是最新</span>' : ''}</span>
      <span class="actions">
        <button class="btn btn-sm" data-vact="check">检查更新</button>
        <button class="btn btn-sm btn-primary" data-vact="update" ${noUpdate ? 'disabled' : ''}>更新</button>
        <button class="btn btn-sm" data-vact="rollback" ${info.backups.length ? '' : 'disabled'}>回滚${info.backups.length ? `（${info.backups.length}）` : ''}</button>
      </span>`
    row.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (updateBusy) return
        const act = btn.dataset.vact
        if (act === 'update' && !confirm(`确认更新 ${c.name}？将自动备份当前版本（正在运行的服务会先停止）。`)) return
        if (act === 'rollback' && !confirm(`确认回滚 ${c.name} 到备份版本？`)) return
        updateBusy = true
        appendUpdateLog(`[${c.name}] ${act} 开始……`)
        try {
          const r = await api('POST', `/api/update/${c.key}/${act}`)
          if (act === 'update') {
            // 202 异步执行：等待 SSE 的 done/error 事件结束 busy 状态
            appendUpdateLog(`[${c.name}] 已提交，后台执行中（进度见上方日志）……`)
            if (!r.started) updateBusy = false
          } else {
            appendUpdateLog(`[${c.name}] ${act} 完成${r.restored ? `（恢复自 ${r.restored}）` : ''}`)
            updateBusy = false
            await refreshStatus()
          }
        } catch (error) {
          appendUpdateLog(`[${c.name}] ${act} 失败：${error.message}`)
          updateBusy = false
        }
      })
    })
    table.appendChild(row)
  }
}

function appendUpdateLog(line) {
  $('#update-log').classList.remove('hidden')
  const body = $('#update-log-body')
  body.textContent += `${new Date().toLocaleTimeString()} ${line}\n`
  body.scrollTop = body.scrollHeight
}

// ---------- 控制台 ----------
function switchLogTab(name) {
  activeLogTab = name
  document.querySelectorAll('.console-tab').forEach(t => t.classList.toggle('active', t.dataset.log === name))
  $('#console-body').textContent = ''
  openLogSource()
}

function openLogSource() {
  if (logSource) logSource.close()
  const body = $('#console-body')
  logSource = new EventSource(`/api/logs/${activeLogTab}?token=${encodeURIComponent(token)}`)
  logSource.addEventListener('history', e => {
    try { body.textContent = JSON.parse(e.data) } catch { /* 忽略 */ }
    autoscrollConsole()
  })
  logSource.addEventListener('log', e => {
    try {
      const chunk = JSON.parse(e.data)
      body.textContent += chunk
      const max = 200000
      if (body.textContent.length > max) body.textContent = body.textContent.slice(-max)
      autoscrollConsole()
    } catch { /* 忽略 */ }
  })
}

function autoscrollConsole() {
  const body = $('#console-body')
  if ($('#console-autoscroll').checked) body.scrollTop = body.scrollHeight
}

// ---------- 初始化与事件 ----------
// ---------- 启动器版本管理 ----------
async function loadLauncherInfo() {
  try {
    const info = await api('GET', '/api/launcher/info')
    $('#ver-launcher').textContent = info.version
    const lv = $('#launcher-version')
    if (lv) lv.textContent = info.version
    const av = $('#about-launcher-version')
    if (av) av.textContent = `启动器 V3 · ${info.version}`
    const cl = $('#launcher-changelog')
    if (cl) cl.textContent = info.changelog
    const latestEl = $('#launcher-latest')
    if (latestEl && info.latest) {
      latestEl.textContent = info.updateAvailable ? `v${info.latest}（可更新）` : `v${info.latest}`
      const msg = $('#launcher-msg')
      if (msg) {
        msg.textContent = info.updateAvailable ? (info.notes || '发现新版本') : '已是最新'
        msg.className = 'msg ' + (info.updateAvailable ? 'err' : 'ok')
      }
    }
  } catch { /* 后端不可用 */ }
}

function bindLauncherUpdate() {
  const msg = $('#launcher-msg')
  const setMsg = (text, cls = '') => { msg.textContent = text; msg.className = cls ? `msg ${cls}` : 'msg' }
  $('#btn-launcher-check').addEventListener('click', async () => {
    setMsg('检查中……')
    try {
      const r = await api('POST', '/api/update/launcher/check')
      $('#launcher-latest').textContent = r.updateAvailable ? `v${r.latest}（可更新）` : `v${r.latest}`
      setMsg(r.updateAvailable ? (r.notes || '发现新版本') : `已是最新（v${r.current}）`, r.updateAvailable ? 'err' : 'ok')
    } catch (e) { setMsg(e.message, 'err') }
  })
  $('#btn-launcher-update').addEventListener('click', async () => {
    setMsg('更新进行中（进度见下方更新日志）……')
    $('#update-log').classList.remove('hidden')
    try { await api('POST', '/api/update/launcher/update') } catch (e) { setMsg(e.message, 'err') }
  })
  $('#btn-launcher-rollback').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/update/launcher/rollback')
      $('#update-log').classList.remove('hidden')
      setMsg(`已恢复 ${r.restored}，点击「重启生效」`, 'ok')
    } catch (e) { setMsg(e.message, 'err') }
  })
  $('#btn-launcher-restart').addEventListener('click', async () => {
    setMsg('启动器正在重启，窗口将自动重载……')
    try { await api('POST', '/api/launcher/restart') } catch (e) { setMsg(`重启失败：${e.message}`, 'err') }
  })
}

// ---------- 事件绑定 ----------
function bindEvents() {
  // 导航
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault()
      goPage(item.dataset.page)
    })
  })
  $('#btn-onboard-models').addEventListener('click', () => goPage('models'))
  $('#btn-onboard-start').addEventListener('click', startAll)
  $('#btn-start-all').addEventListener('click', startAll)
  $('#btn-stop-all').addEventListener('click', stopAll)
  $('#btn-llm-start').addEventListener('click', async () => {
    try { await api('POST', '/api/services/llm/start'); await refreshStatus() } catch (e) { notice(e.message, true) }
  })
  $('#btn-llm-stop').addEventListener('click', async () => {
    await api('POST', '/api/services/llm/stop'); await refreshStatus()
  })
  $('#btn-dsh-start').addEventListener('click', async () => {
    try { await api('POST', '/api/services/dsh/start'); await refreshStatus() } catch (e) { notice(e.message, true) }
  })
  $('#btn-dsh-stop').addEventListener('click', async () => {
    await api('POST', '/api/services/dsh/stop'); await refreshStatus()
  })
  $('#btn-llm-restart').addEventListener('click', () => restartService('llm'))
  $('#btn-dsh-restart').addEventListener('click', () => restartService('dsh'))
  $('#btn-open-harness').addEventListener('click', openHarness)
  $('#btn-open-harness-2').addEventListener('click', openHarness)
  $('#btn-copy-llm').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(status?.services.llm.endpoint ?? ''); notice('已复制端点') } catch { /* 忽略 */ }
  })
  $('#btn-import').addEventListener('click', async () => {
    const path = $('#import-path').value.trim()
    if (!path) return
    try {
      const r = await api('POST', '/api/models/import', { path })
      notice(`已导入 ${r.name}`)
      $('#import-path').value = ''
      await loadInstalled()
    } catch (e) { notice(`导入失败：${e.message}`, true) }
  })
  $('#btn-hub-search').addEventListener('click', () => hubSearch(true))
  $('#hub-query').addEventListener('keydown', e => { if (e.key === 'Enter') hubSearch(true) })
  $('#btn-hub-more').addEventListener('click', () => hubSearch(false))
  $('#hub-file-filter').addEventListener('input', () => { if (hubRepo) renderHubFiles(hubRepo) })
  $('#hub-file-sort').addEventListener('change', () => { if (hubRepo) renderHubFiles(hubRepo) })
  $('#hub-allowlist').addEventListener('change', async () => {
    try {
      await api('PUT', '/api/config', { HUB_ALLOWLIST_ONLY: $('#hub-allowlist').checked ? '1' : '0' })
      await refreshStatus()
      hubSearch()
    } catch (e) { notice(`设置失败：${e.message}`, true) }
  })
  $('#btn-hub-close').addEventListener('click', () => $('#hub-files').classList.add('hidden'))
  $('#settings-form').addEventListener('submit', async e => {
    e.preventDefault()
    const body = {}
    for (const el of e.target.elements) {
      if (!el.name) continue
      body[el.name] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value
    }
    try {
      await api('PUT', '/api/config', body)
      $('#settings-msg').textContent = '已保存 ✓'
      $('#settings-msg').className = 'msg ok'
      await refreshStatus()
    } catch (err) {
      $('#settings-msg').textContent = `保存失败：${err.message}`
      $('#settings-msg').className = 'msg err'
    }
  })
  $('#btn-chat-send').addEventListener('click', sendChat)
  $('#btn-chat-clear').addEventListener('click', clearChat)
  $('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat() }
  })
  document.querySelectorAll('.console-tab').forEach(t => t.addEventListener('click', () => switchLogTab(t.dataset.log)))
  $('#btn-console-clear').addEventListener('click', () => { $('#console-body').textContent = '' })
  $('#btn-console-collapse').addEventListener('click', () => {
    const c = $('#console')
    c.classList.toggle('collapsed')
    $('#btn-console-collapse').textContent = c.classList.contains('collapsed') ? '展开' : '收起'
  })
  $('#btn-update-log-clear').addEventListener('click', () => { $('#update-log-body').textContent = '' })
  document.querySelectorAll('[data-dir]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/open-dir', { path: btn.dataset.dir }) } catch (e) { notice(e.message, true) }
    })
  })
  const quitFn = async () => {
    if (!confirm('退出启动器将停止本地大模型与 Harness 等全部服务。确认退出？')) return
    try { await api('POST', '/api/quit') } catch { /* 已退出 */ }
    notice('启动器已退出，全部服务已停止。可以关闭此页面。')
  }
  $('#btn-quit-side').addEventListener('click', quitFn)
  bindLauncherUpdate()
  // 下载进度
  const dlEvents = new EventSource(`/api/downloads/events?token=${encodeURIComponent(token)}`)
  dlEvents.addEventListener('task', e => {
    try { onDownloadTask(JSON.parse(e.data)) } catch { /* 忽略 */ }
  })
  // 更新进度
  const updEvents = new EventSource(`/api/update/events?token=${encodeURIComponent(token)}`)
  updEvents.addEventListener('event', e => {
    try {
      const evt = JSON.parse(e.data)
      if (evt.type === 'log') appendUpdateLog(`[${evt.component}] ${evt.line}`)
      if (evt.type === 'done') {
        appendUpdateLog(`[${evt.component}] ✓ 完成`); updateBusy = false; refreshStatus()
        if (evt.component === 'launcher') {
          const msg = $('#launcher-msg')
          msg.textContent = '完成，点击「重启生效」'; msg.className = 'msg ok'
          loadLauncherInfo()
        }
      }
      if (evt.type === 'error') {
        appendUpdateLog(`[${evt.component}] ✗ 失败：${evt.line}`); updateBusy = false; refreshStatus()
        if (evt.component === 'launcher') {
          const msg = $('#launcher-msg')
          msg.textContent = `失败：${evt.line}`; msg.className = 'msg err'
        }
      }
    } catch { /* 忽略 */ }
  })
  // V3：服务重启进度
  const svcEvents = new EventSource(`/api/services/events?token=${encodeURIComponent(token)}`)
  svcEvents.addEventListener('service', e => {
    try {
      const evt = JSON.parse(e.data)
      if (evt.type !== 'restart') return
      const info = { phase: evt.phase, detail: evt.detail }
      if (evt.service === 'dsh') {
        renderRestartProgress('dsh', info, $('#dsh-restart-progress'), $('#btn-dsh-restart'), $('#btn-dsh-start'), $('#btn-dsh-stop'))
      } else {
        renderRestartProgress('llm', info, $('#llm-restart-progress'), $('#btn-llm-restart'), $('#btn-llm-start'), $('#btn-llm-stop'))
      }
      if (evt.phase === 'ready' || evt.phase === 'error') refreshStatus()
    } catch { /* 忽略 */ }
  })
}

async function openHarness() {
  try {
    const r = await api('GET', '/api/harness/url')
    if (r.url) window.open(r.url, '_blank')
    else notice('Harness 未运行，请先启动。', true)
  } catch (e) { notice(e.message, true) }
}

async function init() {
  bindEvents()
  const themeSel = bindTheme()
  if (themeSel) themeSel.addEventListener('change', () => {}) // 主题变更已在 bindTheme 内处理
  renderHubHistory()
  openLogSource()
  try {
    await refreshStatus()
    await loadInstalled()
    renderPresets()
    loadLauncherInfo()
    if (themeSel && status?.config?.THEME) {
      themeSel.value = status.config.THEME
      applyTheme(status.config.THEME)
    } else if (themeSel) {
      applyTheme(themeSel.value)
    }
  } catch (error) {
    notice(`无法连接启动器后端：${error.message}`, true)
  }
  setInterval(refreshStatus, 4000)
}

init()
