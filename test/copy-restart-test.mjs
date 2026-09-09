/**
 * 副本重启测试（D:\dsh-launcher-copy，独立端口 7611/3081/8081）：
 *  1. 启动副本后端（node 独立模式）
 *  2. 启动副本 dsh（:3081）
 *  3. POST /api/launcher/restart（node 模式 relaunch：退出前写状态文件，exit 后拉起新实例）
 *  4. 等新实例起来，验证 dsh 被自动恢复、状态文件被消费
 *  5. 清理（杀掉副本进程树）
 * 不触碰真实 D:\dsh-launcher 的任何进程。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, watch } from 'node:fs'

const COPY = 'D:\\dsh-launcher-copy'
const NODE = 'D:\\dsh-launcher\\runtime\\node\\node.exe'
const MAIN = `${COPY}\\server-v3\\main.mjs`
const PORT = 7611
const DSH_PORT = 3081
const STATE_FILE = `${COPY}\\data\\launcher-services.json`
const TOKEN_FILE = `${COPY}\\logs\\launcher-v3.token`

let passed = 0, failed = 0
const ok = (cond, label) => { if (cond) { passed++; console.log(`  ✓ ${label}`) } else { failed++; console.log(`  ✗ ${label}`) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const base = `http://127.0.0.1:${PORT}`
async function waitFor(fn, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v } catch { /* 继续等 */ }
    await sleep(stepMs)
  }
  return null
}
let token = null
async function api(method, path) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

console.log('① 启动副本后端 (node 独立模式, :7611)')
rmSync(STATE_FILE, { force: true })
const child = spawn(NODE, [MAIN], { cwd: COPY, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let childOut = ''
child.stdout.on('data', d => { childOut += d.toString() })
child.stderr.on('data', d => { childOut += d.toString() })
const up1 = await waitFor(async () => {
  const r = await fetch(`${base}/api/ping`).then(() => true).catch(() => false)
  if (r) { token = readFileSync(TOKEN_FILE, 'utf8').trim() }
  return r
}, 20000)
ok(up1 === true, '副本后端已启动 :7611')
if (!up1) { console.log(childOut); process.exit(1) }

console.log('② 启动副本 dsh (:3081)')
const r2 = await api('POST', '/api/services/dsh/start')
ok(r2.status === 200 && r2.data?.running === true, `副本 dsh 启动 pid=${r2.data?.pid} ${r2.data?.url ?? r2.data?.error}`)
if (!(r2.status === 200 && r2.data?.running === true)) { console.log(childOut); process.exit(1) }

console.log('③ 触发副本重启 /api/launcher/restart')
const r3 = await api('POST', '/api/launcher/restart')
ok(r3.status === 200, `restart 返回 ${r3.status}`)

console.log('④ 旧实例退出 → 新实例启动 → 自动恢复 dsh')
// 旧实例退出（状态文件应已写入）
const fileWritten = await waitFor(async () => existsSync(STATE_FILE), 30000)
ok(fileWritten === true, '退出前写入状态文件')
if (fileWritten) {
  const svc = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  ok(svc.dsh === true && svc.llm === false, `状态内容 dsh=${svc.dsh} llm=${svc.llm}`)
}
// 新实例起来（新 token）
const oldToken = token
let newUp = false
for (let i = 0; i < 60; i++) {
  await sleep(500)
  try {
    const r = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false)
    if (r) {
      const t2 = readFileSync(TOKEN_FILE, 'utf8').trim()
      if (t2 !== oldToken) { token = t2; newUp = true; break }
    }
  } catch { /* 旧实例还占着端口 */ }
}
ok(newUp === true, '新实例已启动（新 token）')
if (!newUp) { console.log(childOut); process.exit(1) }
// 等自动恢复 dsh
const restored = await waitFor(async () => {
  const st = await api('GET', '/api/status')
  return st.data?.services?.dsh?.running ? st.data.services.dsh : null
}, 60000)
ok(restored !== null, `新实例自动恢复 dsh pid=${restored?.pid} port=${restored?.port}`)
ok(!existsSync(STATE_FILE), '状态文件已消费（删除）')

console.log('⑤ 清理副本进程树')
spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
// 新实例是 detached 进程，按端口查杀兜底
await sleep(1000)
const net = spawnSync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true })
const pids = new Set()
for (const line of (net.stdout ?? '').toString().split(/\r?\n/)) {
  const p = line.trim().split(/\s+/)
  if (p.length >= 5 && p[3] === 'LISTENING' && (p[1].endsWith(`:${PORT}`) || p[1].endsWith(`:${DSH_PORT}`))) pids.add(p[4])
}
for (const pid of pids) if (pid !== '0') spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true })
await sleep(500)

console.log(`\n副本测试结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) { console.log('--- 副本后端输出 ---'); console.log(childOut.slice(-3000)) }
process.exit(failed === 0 ? 0 : 1)
