// mock dsh web：监听 --port，打印 token URL，直到被杀。
import http from 'node:http'
const args = process.argv.slice(2)
const host = args[args.indexOf('--host') + 1] ?? '127.0.0.1'
const port = Number(args[args.indexOf('--port') + 1])
const server = http.createServer((req, res) => { res.end('ok') })
server.listen(port, host, () => {
  // 与真 dsh 相同的日志行格式：dsh web: http://host:port/?token=...
  console.log(`dsh web: http://${host}:${port}/?token=MOCKTOKEN-${process.pid}`)
})
process.on('SIGTERM', () => process.exit(0))
