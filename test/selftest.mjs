/**
 * V3 启动器自测：mock dsh 全流程。
 * 覆盖：启动 / 重启编排（202 + SSE 阶段）/ 陈旧状态自愈 / 孤儿端口占用者查杀 / llm 重启错误路径。
 * 用法：node test\selftest.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixture')
const DSH_PORT = 3999
const BACKEND_PORT = 7999
const STEPLOG = join(here, 'selftest.steps.log')
const step = m => appendFileSync(STEPLOG, `[${new Date().toISOString()}] ${m}\n`)
rmSync(STEPLOG, { force: true })
step('test start')

// 关键：core.mjs 在 import 时缓存 ROOT（DSH_LAUNCHER_ROOT 环境变量）。
// 必须先设好环境变量，再用「动态 import」取 LAUNCHER_VERSION —— 若用静态 import，
// 它会被提升到赋值之前，ROOT 就会指向开发树而非 fixture，甚至查杀真实 3080 端口。
process.env.DSH_LAUNCHER_ROOT = FIXTURE
const { LAUNCHER_VERSION } = await import(pathToFileURL(join(here, '..', 'server-v3', 'core.mjs')).href)

let passed = 0
let failed = 0
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
  step(`${cond ? 'PASS' : 'FAIL'} ${label}`)
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ---------- 1. 建 fixture ----------
console.log('① 准备 fixture')
step('① fixture setup start')
rmSync(FIXTURE, { recursive: true, force: true })
mkdirSync(join(FIXTURE, 'config'), { recursive: true })
mkdirSync(join(FIXTURE, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
writeFileSync(join(FIXTURE, 'config', 'launcher.env'),
  `# V3 selftest\nDSH_PORT=${DSH_PORT}\nLLM_PORT=3998\nOPEN_BROWSER=0\n`)
writeFileSync(join(FIXTURE, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  readFileSync(join(here, 'mock-dsh.js'), 'utf8'))
ok(true, `fixture @ ${FIXTURE}`)
step('① fixture done')

// ---------- 2. 启动 V3 后端（进程内） ----------
console.log('② 启动 V3 后端（DSH_LAUNCHER_ROOT=fixture）')
step('② backend import start')
process.env.DSH_LAUNCHER_ROOT = FIXTURE
const { startServer, shutdown } = await import(pathToFileURL(join(here, '..', 'server-v3', 'main.mjs')).href)
const { port: bport, token } = await startServer({ port: BACKEND_PORT })
ok(bport > 0, `后端监听 :${bport}`)
step('② backend up')

const base = `http://127.0.0.1:${bport}`
async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}
const tokenOf = url => { const m = /token=([A-Za-z0-9-]+)/.exec(url ?? ''); return m?.[1] ?? null }
const pidOf = url => { const m = /MOCKTOKEN-(\d+)/.exec(url ?? ''); return m ? Number(m[1]) : null }

async function waitFor(fn, timeoutMs = 30000, stepMs = 300) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch { /* 轮询中瞬时异常，继续等 */ }
    await sleep(stepMs)
  }
  return null
}

// SSE 收集器：收集直到收到目标服务的终态（ready/error）或超时
async function collectServiceEvents(service, timeoutMs = 30000) {
  const events = []
  const controller = new AbortController()
  try {
    const res = await fetch(`${base}/api/services/events?token=${encodeURIComponent(token)}`, { signal: controller.signal })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const started = Date.now()
    let finished = false
    while (!finished && Date.now() - started < timeoutMs) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const data = /^data: (.*)$/m.exec(chunk)?.[1]
        if (!data) continue
        try {
          const evt = JSON.parse(data)
          events.push(evt)
          if (evt.type === 'restart' && evt.service === service && (evt.phase === 'ready' || evt.phase === 'error')) finished = true
        } catch { /* 忽略 */ }
      }
      if (finished) break
    }
  } catch { /* 中止 */ }
  controller.abort()
  return events
}

// ---------- 3. 初始状态 ----------
console.log('③ 初始状态')
step('③ initial status')
{
  const ping = await fetch(`${base}/api/ping`).then(r => r.json())
  ok(ping.ok === true, '/api/ping 无需认证')
  const unauth = await fetch(`${base}/api/status`)
  ok(unauth.status === 401, '无 token → 401')
  const st = await api('GET', '/api/status')
  ok(st.data.versions?.launcher === LAUNCHER_VERSION, `status 携带 launcher 版本 ${LAUNCHER_VERSION}`)
  ok(st.data.services.dsh.running === false, 'dsh 初始未运行')
  ok(st.data.restarting && typeof st.data.restarting === 'object', 'status 携带 restarting 字段')
}

// ---------- 4. 启动 dsh ----------
console.log('④ 启动 dsh')
step('④ dsh start')
let dshUrl1 = null
let dshPid1 = null
{
  const r = await api('POST', '/api/services/dsh/start')
  if (!(r.status === 200 && r.data?.running === true)) console.log('    ④ 失败响应:', r.status, JSON.stringify(r.data))
  ok(r.status === 200 && r.data?.running === true, `dsh 启动成功 pid=${r.data?.pid}`)
  dshUrl1 = r.data?.url
  dshPid1 = r.data?.pid
  ok(/MOCKTOKEN-/.test(dshUrl1 ?? ''), `token URL 已解析: ${dshUrl1}`)
}

// ---------- 5. 重启编排（GUI 场景：调用方存活） ----------
console.log('⑤ 重启 dsh（202 + SSE 阶段）')
step('⑤ dsh restart')
{
  const collector = collectServiceEvents('dsh') // 与重启并行，收到终态即停
  const r = await api('POST', '/api/services/dsh/restart')
  ok(r.status === 202 && r.data.started === true, 'restart 立即 202 返回')
  // 409 重复提交
  const dup = await api('POST', '/api/services/dsh/restart')
  ok(dup.status === 409, '重启中重复提交 → 409')
  const ready = await waitFor(async () => {
    const st = await api('GET', '/api/status')
    const done = st.data.restarting.dsh?.phase === 'ready' || !st.data.restarting.dsh
    return done && st.data.services.dsh.running ? st.data.services.dsh : null
  }, 30000)
  ok(ready !== null, '重启完成，dsh 恢复运行')
  const dshUrl2 = ready?.url ?? null
  const events = await collector
  const phases = events.filter(e => e.type === 'restart' && e.service === 'dsh').map(e => e.phase)
  console.log('    SSE 阶段:', phases.join(' → '))
  ok(phases.includes('stopping') && phases.includes('starting') && phases.includes('ready'), 'SSE 收到 stopping → starting → ready')
  ok(dshUrl2 !== dshUrl1, '新 token URL 已更新（logs\\dsh.url 随之刷新）')
  const newPid = pidOf(dshUrl2)
  ok(newPid !== null && newPid !== dshPid1, `新进程 pid=${newPid}（旧 ${dshPid1}）`)
  const fileUrl = readFileSync(join(FIXTURE, 'logs', 'dsh.url'), 'utf8').trim()
  ok(fileUrl === dshUrl2, 'dsh.url 文件与状态一致')
  dshUrl1 = dshUrl2; dshPid1 = newPid
}

// ---------- 6. 陈旧状态自愈（绕过启动器杀进程后直接 start） ----------
console.log('⑥ 陈旧状态自愈（agent 绕过启动器杀 dsh）')
step('⑥ stale-state self-heal')
{
  spawnSync('taskkill', ['/PID', String(dshPid1), '/T', '/F'], { windowsHide: true })
  await sleep(1000)
  const stBefore = await api('GET', '/api/status')
  ok(stBefore.data.services.dsh.running === false, '直接杀后 status 显示未运行')
  const r = await api('POST', '/api/services/dsh/start')
  ok(r.status === 200 && r.data.running === true, '陈旧内存状态自愈，start 未被「已在运行」挡住')
  dshUrl1 = r.data.url; dshPid1 = pidOf(r.data.url)
}

// ---------- 7. 孤儿端口占用者查杀（agent 自启动 dsh 占着端口） ----------
console.log('⑦ 孤儿端口占用者查杀')
step('⑦ orphan port-holder kill')
{
  // 先经启动器停掉受管的 dsh
  await api('POST', '/api/services/dsh/stop')
  await sleep(500)
  // 起一个不受管理的进程占着 DSH_PORT（模拟 agent 自己 spawn 的 dsh）
  const nodeExe = process.execPath
  const orphan = spawn(nodeExe, [join(FIXTURE, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'web', '--host', '127.0.0.1', '--port', String(DSH_PORT), '--no-open'], {
    cwd: FIXTURE, windowsHide: true, stdio: 'ignore',
  })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DSH_PORT}/`).then(() => true).catch(() => false)), 8000)
  ok(orphan.pid !== undefined, `孤儿进程占用 :${DSH_PORT} pid=${orphan.pid}`)
  const r = await api('POST', '/api/services/dsh/restart')
  ok(r.status === 202, 'restart 202')
  const ready = await waitFor(async () => {
    const st = await api('GET', '/api/status')
    const done = st.data.restarting.dsh?.phase === 'ready' || !st.data.restarting.dsh
    return done && st.data.services.dsh.running ? st.data.services.dsh : null
  }, 30000)
  ok(ready !== null, '孤儿被启动器查杀后重启成功')
  const orphanGone = await waitFor(() => (orphan.exitCode !== null ? true : null), 10000)
  ok(orphanGone === true, `孤儿进程已被查杀退出 (exitCode=${orphan.exitCode})`)
  const fileUrl = readFileSync(join(FIXTURE, 'logs', 'dsh.url'), 'utf8').trim()
  ok(pidOf(fileUrl) !== orphan.pid, 'dsh.url 指向新受管进程而非孤儿')
  dshUrl1 = ready.url; dshPid1 = ready.pid
}

// ---------- 8. llm 重启错误路径（fixture 无 llama-server.exe） ----------
console.log('⑧ llm 重启错误路径')
step('⑧ llm restart error path')
{
  const collector = collectServiceEvents('llm')
  const r = await api('POST', '/api/services/llm/restart')
  ok(r.status === 202, 'llm restart 202')
  const errState = await waitFor(async () => {
    const st = await api('GET', '/api/status')
    return st.data.restarting.llm?.phase === 'error' ? st.data.restarting.llm : null
  }, 20000)
  ok(errState !== null, `llm 重启进入 error 阶段: ${errState?.detail}`)
  ok(/llama-server/.test(errState?.detail ?? ''), '错误信息指向缺失的 llama-server')
  await collector
}

// ---------- 9. 收尾 + 服务状态自动恢复（第二实例） ----------
// 退出前 dsh 仍在运行（⑦ 之后）→ 退出时写 launcher-services.json；
// 拉起第二个实例（模拟 relaunch）→ 新实例应自动恢复 dsh 并消费状态文件。
console.log('⑨ 状态文件 + 第二实例自动恢复')
step('⑨ service-state restore')
{
  const stateFile = join(FIXTURE, 'data', 'launcher-services.json')
  const realExit = process.exit.bind(process)
  // shutdown() 在停完子进程 500ms 后 process.exit(0)：吞掉，让测试进程继续跑
  process.exit = () => {}
  await shutdown('selftest')
  ok(true, '后端已停止（退出前 dsh 运行中）')
  ok(existsSync(stateFile), '退出时写入状态文件 launcher-services.json')
  const svc = JSON.parse(readFileSync(stateFile, 'utf8'))
  ok(svc.dsh === true && svc.llm === false, `状态内容 dsh=${svc.dsh} llm=${svc.llm}`)

  // 第二实例（独立进程，模拟 relaunch 后的新实例）
  const childLog = join(here, 'selftest.child.log')
  const child = spawn(process.execPath, [join(here, '..', 'server-v3', 'main.mjs'), '--port=7998'], {
    cwd: FIXTURE, env: { ...process.env, DSH_LAUNCHER_ROOT: FIXTURE }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childBuf = ''
  child.stdout.on('data', d => { childBuf += d.toString() })
  child.stderr.on('data', d => { childBuf += d.toString() })
  try { appendFileSync(childLog, '') } catch { /* 忽略 */ }
  const up = await waitFor(async () => {
    return (await fetch('http://127.0.0.1:7998/api/ping').then(() => true).catch(() => false))
  }, 15000)
  ok(up === true, '第二实例已启动 :7998')
  const childToken = readFileSync(join(FIXTURE, 'logs', 'launcher-v3.token'), 'utf8').trim()
  const restored = await waitFor(async () => {
    const res = await fetch('http://127.0.0.1:7998/api/status', { headers: { Authorization: `Bearer ${childToken}` } })
    const st = await res.json().catch(() => null)
    return st?.services?.dsh?.running ? st.services.dsh : null
  }, 30000)
  ok(restored !== null, '第二实例自动恢复 dsh（状态文件被消费）')
  ok(!existsSync(stateFile), '状态文件已消费（删除）')
  if (!restored) {
    try { appendFileSync(childLog, childBuf) } catch { /* 忽略 */ }
  }
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  await sleep(300)
  // 收尾：恢复 process.exit 并显式退出（http server 未 close，需显式退出）
  process.exit = realExit
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
step(`RESULT ${passed} passed / ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
