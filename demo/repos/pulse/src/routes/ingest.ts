import type { IncomingMessage, ServerResponse } from 'node:http'

export async function ingest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const events = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown[]

  res.writeHead(202, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ accepted: events.length }))
}
