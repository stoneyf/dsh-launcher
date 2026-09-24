/**
 * V3 启动器自测：mock dsh 全流程。
 * 覆盖：启动 / 重启编排（202 + SSE 阶段）/ 陈旧状态自愈 / 孤儿端口占用者查杀 / llm 重启错误路径。
 * 用法：node test\selftest.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
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
const { LAUNCHER_VERSION } = await import(pathToFileURL(join(here, '..', 'server', 'core.mjs')).href)

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

// ---------- 2. 启动 V4 后端（进程内） ----------
console.log('② 启动 V4 后端（DSH_LAUNCHER_ROOT=fixture）')
step('② backend import start')
process.env.DSH_LAUNCHER_ROOT = FIXTURE
const { startServer, shutdown } = await import(pathToFileURL(join(here, '..', 'server', 'main.mjs')).href)
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

// ---------- 8b. 重启续跑意图（4.1.5） ----------
console.log('⑧b 重启续跑意图（launcher/restart + resume）')
step('⑧b resume intent')
{
  const rf = join(FIXTURE, 'data', 'launcher-resume.json')
  // 显式 sessionId：写入意图文件；自测模式无 relauncher → 500，但意图仍应落盘
  const r = await api('POST', '/api/launcher/restart', { sessionId: 'session-abc' })
  ok(r.status === 500, '自测模式（无 relauncher）→ 500')
  ok(r.data?.resume === 'session-abc', '响应回显续跑目标会话')
  ok(existsSync(rf), '意图文件 launcher-resume.json 已写入')
  const intent = JSON.parse(readFileSync(rf, 'utf8'))
  ok(intent.sessionId === 'session-abc' && intent.text === '继续', `意图内容正确（默认文案「继续」）: ${JSON.stringify(intent)}`)
  // 无 sessionId → 取最近更新过的会话（按 mtime）
  const sdir = join(FIXTURE, 'data', 'sessions', 'prof')
  mkdirSync(join(sdir, 'session-old'), { recursive: true })
  mkdirSync(join(sdir, 'session-new'), { recursive: true })
  const oldF = join(sdir, 'session-old', 'session.jsonl.zstd')
  const newF = join(sdir, 'session-new', 'session.jsonl.zstd')
  writeFileSync(oldF, 'old'); writeFileSync(newF, 'new')
  const now = Date.now()
  utimesSync(oldF, new Date(now - 100000), new Date(now - 100000))
  utimesSync(newF, new Date(now), new Date(now))
  const r2 = await api('POST', '/api/launcher/restart', {})
  const intent2 = JSON.parse(readFileSync(rf, 'utf8'))
  ok(intent2.sessionId === 'session-new', '无 sessionId → 选最近更新的会话')
  rmSync(rf, { force: true })
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

  // 4.1.5 重启续跑：预置续跑意图，第二实例恢复 dsh 后应自动向该会话发「继续」
  const resumeFile = join(FIXTURE, 'data', 'launcher-resume.json')
  writeFileSync(resumeFile, JSON.stringify({ sessionId: 'session-resume-test', text: '继续' }, null, 2))

  // 第二实例（独立进程，模拟 relaunch 后的新实例）
  const childLog = join(here, 'selftest.child.log')
  const child = spawn(process.execPath, [join(here, '..', 'server', 'main.mjs'), '--port=7998'], {
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
  const childToken = readFileSync(join(FIXTURE, 'logs', 'launcher.token'), 'utf8').trim()
  const restored = await waitFor(async () => {
    const res = await fetch('http://127.0.0.1:7998/api/status', { headers: { Authorization: `Bearer ${childToken}` } })
    const st = await res.json().catch(() => null)
    return st?.services?.dsh?.running ? st.services.dsh : null
  }, 30000)
  ok(restored !== null, '第二实例自动恢复 dsh（状态文件被消费）')
  ok(!existsSync(stateFile), '状态文件已消费（删除）')
  // 重启续跑：第二实例应向目标会话发出 session/prompt（mock dsh 落盘 rpc-calls.log）
  const rpcLog = join(FIXTURE, 'rpc-calls.log')
  const prompted = await waitFor(async () => {
    if (!existsSync(rpcLog)) return null
    const lines = readFileSync(rpcLog, 'utf8').split('\n').filter(Boolean)
    const hit = lines.map(l => { try { return JSON.parse(l) } catch { return null } })
      .find(x => x?.endpoint === 'session/prompt' && x?.msg?.payload?.args?.request?.sessionId === 'session-resume-test')
    return hit ?? null
  }, 30000)
  ok(prompted !== null, '第二实例恢复 dsh 后自动发送「继续」（session/prompt 已送达）')
  if (prompted) {
    ok(prompted.msg.payload.args.request.content?.[0]?.text === '继续', '续跑消息内容为「继续」')
    ok(prompted.msg.type === 'client-request' && prompted.msg.method === 'session/prompt', 'RPC 封装正确（client-request / method 与路径一致）')
  }
  ok(!existsSync(resumeFile), '续跑意图文件已消费（删除）')
  if (!restored || !prompted) {
    try { appendFileSync(childLog, childBuf) } catch { /* 忽略 */ }
  }
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  await sleep(300)
  // 收尾：恢复 process.exit 并显式退出（http server 未 close，需显式退出）
  process.exit = realExit
}

// ---------- 9b. 重启续跑缺省路径（无意图文件 → 最近更新的会话） ----------
step('⑨b resume default (no intent file)')
{
  // 上一实例被强杀（无干净退出）→ 手动补状态文件，模拟「上实例有运行中服务」的重启路径；
  // 不写续跑意图文件（模拟旧版本实例没写文件的首次重启场景），⑧b 已建 prof/session-old + prof/session-new（new 更新）
  const stateFile2 = join(FIXTURE, 'data', 'launcher-services.json')
  writeFileSync(stateFile2, JSON.stringify({ dsh: true, llm: false }))
  const childLog2 = join(here, 'selftest.child2.log')
  const child2 = spawn(process.execPath, [join(here, '..', 'server', 'main.mjs'), '--port=7998'], {
    cwd: FIXTURE, env: { ...process.env, DSH_LAUNCHER_ROOT: FIXTURE }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let child2Buf = ''
  child2.stdout.on('data', d => { child2Buf += d.toString() })
  child2.stderr.on('data', d => { child2Buf += d.toString() })
  const up2 = await waitFor(async () => {
    return (await fetch('http://127.0.0.1:7998/api/ping').then(() => true).catch(() => false))
  }, 15000)
  ok(up2 === true, '第二实例 B 已启动 :7998（无意图文件）')
  const childToken2 = readFileSync(join(FIXTURE, 'logs', 'launcher.token'), 'utf8').trim()
  const restored2 = await waitFor(async () => {
    const res = await fetch('http://127.0.0.1:7998/api/status', { headers: { Authorization: `Bearer ${childToken2}` } })
    const st = await res.json().catch(() => null)
    return st?.services?.dsh?.running ? st.services.dsh : null
  }, 30000)
  ok(restored2 !== null, '第二实例 B 自动恢复 dsh（状态文件被消费）')
  const rpcLog2 = join(FIXTURE, 'rpc-calls.log')
  const hit2 = await waitFor(async () => {
    if (!existsSync(rpcLog2)) return null
    const lines = readFileSync(rpcLog2, 'utf8').split('\n').filter(Boolean)
    return lines.map(l => { try { return JSON.parse(l) } catch { return null } })
      .find(x => x?.endpoint === 'session/prompt' && x?.msg?.payload?.args?.request?.sessionId === 'session-new') ?? null
  }, 30000)
  ok(hit2 !== null, '无意图文件 → 缺省续跑最近更新的会话（session/prompt → session-new）')
  if (hit2) ok(hit2.msg.payload.args.request.content?.[0]?.text === '继续', '缺省续跑文案「继续」')
  spawnSync('taskkill', ['/PID', String(child2.pid), '/T', '/F'], { windowsHide: true })
  await sleep(300)
  if (!restored2 || !hit2) {
    try { appendFileSync(childLog2, child2Buf) } catch { /* 忽略 */ }
  }
}

// ---------- 10. 开机自启服务锁（4.1.8）：跨实例互斥 ----------
// 免登录开机后会有两个启动器实例（SYSTEM 开机实例 + 登录实例），二者都会跑到
// ensureAutoStartServices；无锁时各拉一份 llama-server，同一模型加载两次 → 显存争抢
// →「切本地模型卡住」。这里验证：锁已被持有（未过期）时，第二个实例会跳过带服务。
console.log('⑩ 开机自启服务锁（跨实例互斥）')
step('⑩ autostart lock start')
{
  const lockFile = join(FIXTURE, 'logs', 'autostart-services.lock')
  mkdirSync(join(FIXTURE, 'logs'), { recursive: true })
  // 模拟「另一个实例正在带服务」：写入未过期的锁
  writeFileSync(lockFile, JSON.stringify({ at: Date.now(), pid: 999999 }))
  const childLog3 = join(here, 'selftest.child3.log')
  const child3 = spawn(process.execPath, [join(here, '..', 'server', 'main.mjs'), '--port=7997', '--silent'], {
    cwd: FIXTURE, env: { ...process.env, DSH_LAUNCHER_ROOT: FIXTURE }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let child3Buf = ''
  child3.stdout.on('data', d => { child3Buf += d.toString() })
  child3.stderr.on('data', d => { child3Buf += d.toString() })
  const up3 = await waitFor(async () => {
    return (await fetch('http://127.0.0.1:7997/api/ping').then(() => true).catch(() => false))
  }, 15000)
  ok(up3 === true, '第三实例已启动 :7997')
  // 未过期的锁 → 应看到「已有实例（pid …）在处理带服务，本实例跳过」，且不启动 llm
  const skipped = await waitFor(async () => {
    return /已有实例（pid \d+）在处理带服务/.test(child3Buf) ? true : null
  }, 10000)
  ok(skipped === true, '锁被持有时：第二实例跳过带服务（不重复拉起 llm/dsh）')
  ok(/本实例跳过/.test(child3Buf), '跳过日志含明确的「本实例跳过」提示')
  ok(!child3Buf.includes('开机自启：启动本地大模型'), '跳过带服务 → 没有重复启动本地大模型')
  spawnSync('taskkill', ['/PID', String(child3.pid), '/T', '/F'], { windowsHide: true })
  await sleep(300)
  // 过期锁 → 应被接管后正常执行
  writeFileSync(lockFile, JSON.stringify({ at: Date.now() - 10 * 60 * 1000, pid: 999998 }))
  const childLog4 = join(here, 'selftest.child4.log')
  const child4 = spawn(process.execPath, [join(here, '..', 'server', 'main.mjs'), '--port=7996', '--silent'], {
    cwd: FIXTURE, env: { ...process.env, DSH_LAUNCHER_ROOT: FIXTURE }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let child4Buf = ''
  child4.stdout.on('data', d => { child4Buf += d.toString() })
  child4.stderr.on('data', d => { child4Buf += d.toString() })
  const up4 = await waitFor(async () => {
    return (await fetch('http://127.0.0.1:7996/api/ping').then(() => true).catch(() => false))
  }, 15000)
  ok(up4 === true, '第四实例已启动 :7996')
  const tookOver = await waitFor(async () => {
    return child4Buf.includes('接管过期锁') ? true : null
  }, 10000)
  ok(tookOver === true, '锁过期 → 新实例接管并继续（不会永久卡死）')
  spawnSync('taskkill', ['/PID', String(child4.pid), '/T', '/F'], { windowsHide: true })
  await sleep(300)
  if (failed > 0) {
    try { appendFileSync(childLog3, child3Buf); appendFileSync(childLog4, child4Buf) } catch { /* 忽略 */ }
  }
}

// ---------- 11. 退出路径静态检查（4.1.8）：托盘「退出」不得死锁 ----------
// 历史 bug：托盘菜单先 `quitting = true` 再调 quitAndShutdown，而后者开头是
// `if (quitting) return` → 直接返回、什么都不做，表现为「托盘点退出没反应」。
// 这里做静态源码检查，防止该写法回归。
console.log('⑪ 退出路径静态检查（托盘退出不死锁）')
step('⑪ exit-path static check start')
{
  const mainSrc = readFileSync(join(here, '..', 'electron', 'main.mjs'), 'utf8')
  // 1) quitting 的赋值只能出现在 quitAndShutdown 内部（函数体内），不得在调用点预先赋值
  const trayLine = mainSrc.split('\n').find(l => l.includes("label: '退出'")) ?? ''
  ok(trayLine.length > 0, '找到托盘「退出」菜单项')
  ok(!/quitting\s*=\s*true/.test(trayLine), '托盘菜单项不再预先设 quitting（死锁根因已消除）')
  // 2) quitting 赋值点应只有 1 处（声明处 let quitting = false 不计）
  const assigns = mainSrc.split('\n').filter(l => /(^|[^=!<>])quitting\s*=\s*true/.test(l))
  ok(assigns.length === 1, `quitting = true 只出现在 1 处（实际 ${assigns.length} 处）`)
  // 3) 退出流程要有兜底强制退出，避免子进程卡住导致退不掉
  ok(/app\.exit\(0\)/.test(mainSrc), '退出流程含兜底强制退出（app.exit）')
  ok(/退出超时/.test(mainSrc), '兜底路径有明确日志（退出超时）')
  // 4) 附着模式退出要有用户可见说明，避免「退了但服务还在」被当成没退干净
  ok(/附着模式，仅关闭本窗口/.test(mainSrc), '附着模式退出有独立分支')
  ok(/后台服务由开机实例托管/.test(mainSrc), '附着模式退出会告知用户服务仍在运行')
}

// ---------- 12. 启动前体检与失败自愈（4.2） ----------
// 目标：dsh 因插件依赖缺失 / 配置写坏而起不来时，启动器能自己查出、修好、
// 必要时禁用坏插件并重试，而不是让用户去手工改文件。
console.log('⑫ 启动前体检与失败自愈（4.2）')
step('⑫ preflight start')
{
  const { runChecks, findDuplicateIds, minimalYamlCheck, parseYaml, disablePlugins, enablePlugins } =
    await import(pathToFileURL(join(here, '..', 'server', 'preflight.mjs')).href)
  const { attributeFailure } = await import(pathToFileURL(join(here, '..', 'server', 'services.mjs')).href)

  // (a) 失败归因：能精确指到插件；不该冤枉 harness 内部包或开发树
  const a1 = attributeFailure("failed to import loader entry slot (bad-plugin): Cannot find package 'x'")
  ok(a1?.plugins?.[0] === 'bad-plugin', '归因：loader 条目失败 → 定位到插件')
  ok(attributeFailure("Cannot find package 'y' imported from D:\\dsh-launcher\\harness\\node_modules\\@deepseek-ai\\dsh-subagent\\lib\\index.js") === null,
    '归因：harness 内部包缺失不算插件问题')
  ok(attributeFailure('Error: AttachConsole failed') === null, '归因：无关报错不误判为插件问题')
  ok(attributeFailure("Cannot find package 'react' imported from D:\\dsh-launcher\\data\\profiles\\web\\node_modules\\dsh-raw-html\\lib\\c.js")?.plugins?.[0] === 'dsh-raw-html',
    '归因：从 profile 内插件目录反查出包名')

  // (b) YAML 检查：真重复键要报，合法文件不能误报
  ok(parseYaml('a:\n  b: 1\n  b: 2\n').ok === false, 'YAML：真实重复键被判定为非法')
  ok(parseYaml('- id: foo\n  name: a\n- id: bar\n  name: b\n').ok === true, 'YAML：同级列表项不算重复键（曾误报）')
  ok(minimalYamlCheck('- id: foo\n  name: a\n- id: bar\n  name: b\n').ok === true, '兜底检查：列表项首键不误报')
  ok(minimalYamlCheck('a:\n  b: 1\n  b: 2\n').ok === false, '兜底检查：能查出重复键')
  ok(findDuplicateIds('- id: foo\n- id: foo\n').length === 1, '重复 id 检测可用（仅提示，非致命）')

  // (c) 体检在 fixture 下不得抛异常；fixture 里有 mock dsh bin，所以本体应判定为「完整」
  const r = runChecks('web')
  ok(Array.isArray(r.checks) && r.checks.length > 0, '体检返回结果数组')
  ok(r.checks.every(c => c && c.id && typeof c.ok === 'boolean' && c.level), '每个检查项都有 id/ok/level')
  ok(r.checks.some(c => c.id === 'harness' && c.ok === true), 'fixture 有 mock dsh bin → 本体判定完整')
  ok(!r.checks.some(c => c.id === undefined), '没有未命名的检查项（曾因漏 spread 产生 undefined 项）')

  // (d) 禁用/恢复插件可回滚（bundles 进出，且留备份）
  const pdir = join(FIXTURE, 'data', 'profiles', 'web')
  mkdirSync(pdir, { recursive: true })
  const pkgFile = join(pdir, 'package.json')
  writeFileSync(pkgFile, JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['a', 'b'] } } }, null, 2))
  const d = disablePlugins(['a'], 'web')
  ok(d.ok && JSON.parse(readFileSync(pkgFile, 'utf8')).dsh.profile.bundles.join(',') === 'b', '禁用插件：从 bundles 移除')
  ok(d.backup && existsSync(d.backup), '禁用插件：改动前留有备份（可回滚）')
  const e = enablePlugins(['a'], 'web')
  ok(e.ok && JSON.parse(readFileSync(pkgFile, 'utf8')).dsh.profile.bundles.includes('a'), '恢复插件：放回 bundles')
}

// ---------- 13. 重启路径必须走体检与自愈（4.2） ----------
// 真实事故（2026-09-24）：从对话里「重启 Harness」后界面一直显示
// 「正在重启 Harness……」，看起来起不来。两个独立原因：
//   ① restartDsh 调的是裸 startDsh，绕过了启动前体检与失败自愈；
//   ② gui 里 notice('正在重启…') 之后**没有任何代码清掉它**，横幅永久停留。
// 这里做静态检查，防止这两处回归。
console.log('⑬ 重启路径走体检与自愈（4.2）')
step('⑬ restart-path start')
{
  const svcSrc = readFileSync(join(here, '..', 'server', 'services.mjs'), 'utf8')
  const appSrc = readFileSync(join(here, '..', 'gui', 'app.js'), 'utf8')

  // (a) restartDsh 必须用 startDshResilient，不能用裸 startDsh
  const restartBlock = svcSrc.slice(svcSrc.indexOf('export async function restartDsh'))
    .slice(0, svcSrc.slice(svcSrc.indexOf('export async function restartDsh')).indexOf('export async function restartLlm'))
  ok(/startDshResilient\(/.test(restartBlock), 'restartDsh 走 startDshResilient（含体检 + 自愈）')
  ok(!/start:\s*\(\)\s*=>\s*startDsh\(\{/.test(restartBlock), 'restartDsh 不再直接调裸 startDsh')
  // (b) 自动恢复 / 开机自启 / startAll 也都走自愈路径
  ok(/results\.dsh = await startDshResilient\(\)/.test(svcSrc), 'startAll 走自愈路径')
  const mainSrc = readFileSync(join(here, '..', 'server', 'main.mjs'), 'utf8')
  const autoCalls = (mainSrc.match(/services\.startDsh\(\{/g) ?? []).length
  ok(autoCalls === 0, `main.mjs 不再调用裸 startDsh（实际 ${autoCalls} 处）`)

  // (c) GUI：重启横幅必须能被清掉
  ok(/function hideNotice\(/.test(appSrc), 'GUI 有 hideNotice()（横幅可收起）')
  const restartFn = appSrc.slice(appSrc.indexOf('async function restartService'))
    .slice(0, 2200)
  ok(/hideNotice\(\)/.test(restartFn), 'restartService 结束时会收起横幅')
  ok(/notice\(`\$\{label\}已重启完成`\)/.test(restartFn), '重启成功有明确完成提示')
  ok(/重启超时|重启失败/.test(restartFn), '重启失败/超时有明确提示（不会永远停在「正在重启」）')

  // (d) 令牌文件自愈：shutdown 删掉后，活着的实例要能补写回来
  ok(/__dshTokenGuard/.test(mainSrc), '令牌文件有自愈补写（避免删掉后永久 401）')
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
step(`RESULT ${passed} passed / ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
