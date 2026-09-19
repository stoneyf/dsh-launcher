// mock dsh web：监听 --port，打印 token URL，直到被杀。
// 4.1.5 起额外最小模拟 dsh web 的认证/RPC 协议，供「重启续跑」自测：
//   · GET /?token=<本进程 token> → 303 + Set-Cookie（launch token 交换）
//   · POST /api/<endpoint>（带 cookie）→ session/prompt 返回 server-response，并把请求追加到 rpc-calls.log（cwd 下）
import http from 'node:http'
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const host = args[args.indexOf('--host') + 1] ?? '127.0.0.1'
const port = Number(args[args.indexOf('--port') + 1])
const TOKEN = `MOCKTOKEN-${process.pid}`
const COOKIE = 'dsh-auth-mock'
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${host}:${port}`)
  if (req.method === 'GET' && u.pathname === '/' && u.searchParams.has('token')) {
    if (u.searchParams.get('token') === TOKEN) {
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': `${COOKIE}=v1.mock; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict`,
      })
      return res.end()
    }
    res.writeHead(400)
    return res.end('bad token')
  }
  if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
    const hasCookie = String(req.headers.cookie ?? '').split(';').map(c => c.trim()).some(c => c.startsWith(`${COOKIE}=`))
    if (!hasCookie) { res.writeHead(401); return res.end('unauthorized') }
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const endpoint = u.pathname.slice('/api/'.length)
      if (endpoint !== 'session/prompt') { res.writeHead(404); return res.end('not found') }
      let msg = null
      try { msg = JSON.parse(body) } catch { /* 非 JSON */ }
      try { appendFileSync('rpc-calls.log', JSON.stringify({ endpoint, at: Date.now(), msg }) + '\n') } catch { /* 忽略 */ }
      const valid = msg && msg.type === 'client-request' && msg.method === endpoint
      const result = valid
        ? { ok: true, value: { accepted: true } }
        : { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: msg?.rpcId ?? 'mock', result }))
    })
    return
  }
  res.end('ok')
})
server.listen(port, host, () => {
  // 与真 dsh 相同的日志行格式：dsh web: http://host:port/?token=...
  console.log(`dsh web: http://${host}:${port}/?token=${TOKEN}`)
})
process.on('SIGTERM', () => process.exit(0))
