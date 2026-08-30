import { createServer } from 'node:http'
import { rateLimit } from './routes/rateLimit.ts'
import { ingest } from './routes/ingest.ts'

const PORT = Number(process.env.PORT ?? 8787)

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  if (url.pathname === '/v1/ingest') {
    const limited = await rateLimit(req)
    if (limited) {
      res.writeHead(429, { 'retry-after': String(limited.retryAfter) })
      res.end('rate limited')
      return
    }
    return ingest(req, res)
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, () => console.log(`pulse listening on :${PORT}`))
