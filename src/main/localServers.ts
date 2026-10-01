import { execFile } from 'node:child_process'
import { request } from 'node:http'
import type { LocalServer } from '../shared/types.ts'

/**
 * Local web servers, found the way a person would: ask the OS what is
 * listening, then knock on each port and keep the ones that answer with a page.
 *
 * Reading the dev server's own output for a URL is still the fast path — it is
 * what the server says the moment it is ready — but it is not enough on its
 * own. A server that never prints a localhost URL (a custom Express app, Rails,
 * a framework that logs `ready on port 3000`) left the preview "starting"
 * forever, and a server the user started in their own terminal was invisible
 * to Carbon entirely, so the agent spawned a second one into a port conflict.
 * The port table answers both.
 *
 * `lsof` rather than `netstat`: it names the owning process, and the process is
 * how a server is matched to a project (its working directory) and to a server
 * Carbon spawned (its parent chain). It only ever sees the user's own
 * processes, which is the right scope anyway.
 */

/** One listening TCP socket, as `lsof -F pcn` reports it. */
export interface ListeningSocket {
  pid: number
  command: string
  host: string
  port: number
}

/**
 * Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcn`: a `p<pid>` line opens a
 * process, `c<command>` names it, and each `n<host>:<port>` is one socket.
 * One entry per process and port — one server bound to both `127.0.0.1` and
 * `[::1]` is one server, preferring the IPv4 binding, which is what
 * `localhost` reaches first from Node and Chromium alike — but two processes
 * on one port (`127.0.0.1:3000` and `127.0.0.2:3000`) stay two.
 */
export function parseLsofListen(text: string): ListeningSocket[] {
  const byPort = new Map<string, ListeningSocket>()
  let pid = 0
  let command = ''
  for (const line of text.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      pid = Number(value)
      command = ''
    } else if (tag === 'c') {
      command = value
    } else if (tag === 'n' && pid) {
      const m = /^(.*):(\d+)$/.exec(value)
      if (!m) continue
      const host = m[1].replace(/^\[|\]$/g, '')
      const port = Number(m[2])
      const key = `${pid}:${port}`
      const prev = byPort.get(key)
      if (!prev || (prev.host.includes(':') && !host.includes(':'))) {
        byPort.set(key, { pid, command, host, port })
      }
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port || a.pid - b.pid)
}

/** Parses `lsof -a -d cwd -p <pids> -F pn` into pid → working directory. */
export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1))
  }
  return out
}

/** Parses `ps -A -o pid=,ppid=` into child → parent. */
export function parsePsParents(text: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (m) out.set(Number(m[1]), Number(m[2]))
  }
  return out
}

/** True when `pid` is `ancestor` or descends from it. */
export function descendsFrom(pid: number, ancestor: number, parents: Map<number, number>): boolean {
  let p: number | undefined = pid
  for (let guard = 0; p && guard < 64; guard++) {
    if (p === ancestor) return true
    p = parents.get(p)
  }
  return false
}

/**
 * Whether a server running in `serverCwd` belongs to the project at `project`:
 * the server runs inside it (a monorepo app's own folder counts). A server
 * started at a *parent* of the project does not — that is some other checkout's
 * workspace root, and a worktree beside it would claim it too.
 */
export function cwdBelongsTo(serverCwd: string | undefined, project: string): boolean {
  if (!serverCwd) return false
  const a = serverCwd.replace(/\/+$/, '')
  const b = project.replace(/\/+$/, '')
  return a === b || a.startsWith(b + '/')
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => {
      // lsof exits 1 when *some* pid it was asked about has gone, with the rest
      // of the answer still on stdout — so the output is used either way.
      resolve(typeof stdout === 'string' ? stdout : '')
    })
  })
}

/**
 * Knocks on a port. Counts as a page: any HTML response, or any 2xx/3xx. That
 * keeps AirPlay's 403 on :5000/:7000, a JSON API's 404 at `/`, and every
 * non-HTTP listener (databases, language servers, debuggers) out of a list that
 * is offered as places to point a browser.
 */
export function probeHttp(port: number, host = '127.0.0.1', timeoutMs = 1200): Promise<{ title?: string } | null> {
  return new Promise((resolve) => {
    let settled = false
    let answered = false
    const done = (v: { title?: string } | null): void => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const req = request(
      { host, port, path: '/', method: 'GET', timeout: timeoutMs, headers: { Accept: 'text/html' } },
      (res) => {
        answered = true
        const type = String(res.headers['content-type'] ?? '')
        const status = res.statusCode ?? 0
        const html = type.includes('html')
        if (!(html || (status >= 200 && status < 400))) {
          res.resume()
          done(null)
          return
        }
        if (!html) {
          res.resume()
          done({})
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
          const t = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)
          if (t || body.length > 32_768) {
            req.destroy()
            done(t ? { title: t[1].trim() } : {})
          }
        })
        res.on('end', () => done({}))
        res.on('error', () => done({}))
      }
    )
    req.on('timeout', () => {
      req.destroy()
      done(null)
    })
    req.on('error', () => done(null))
    // `timeout` above is socket *inactivity*: a page trickling bytes without a
    // <title> would hold the scan open indefinitely. This is the wall clock.
    const deadline = setTimeout(() => {
      req.destroy()
      done(answered ? {} : null)
    }, timeoutMs * 2)
    deadline.unref?.()
    req.on('close', () => clearTimeout(deadline))
    req.end()
  })
}

const SCAN_TTL_MS = 2000
let cached: { at: number; servers: Promise<LocalServer[]>; pending: boolean } | null = null

/**
 * Every local server that answers with a page, with the process behind it and
 * its working directory. Cached briefly so the toolbar menu, the agent's status
 * call and the start fallback asking at once cost one scan.
 */
export function scanLocalServers(opts: { excludePids?: number[]; fresh?: boolean } = {}): Promise<LocalServer[]> {
  if (process.platform === 'win32') return Promise.resolve([])
  const now = Date.now()
  // A scan still running is reused even when a fresh one is asked for: the
  // fallback polls every 1.5 s, and a slow `lsof` must not pile scans up.
  if (cached && (cached.pending || (!opts.fresh && now - cached.at < SCAN_TTL_MS))) return cached.servers
  const servers = (async (): Promise<LocalServer[]> => {
    const listen = parseLsofListen(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], 4000))
    const exclude = new Set(opts.excludePids ?? [])
    const candidates = listen.filter((s) => !exclude.has(s.pid))
    if (!candidates.length) return []
    const pids = [...new Set(candidates.map((s) => s.pid))]
    const cwds = parseLsofCwd(await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-F', 'pn'], 4000))
    const probed = await Promise.all(
      candidates.map(async (s) => {
        const host = s.host === '*' || s.host === '0.0.0.0' ? '127.0.0.1' : s.host === '::' ? '::1' : s.host
        const page = await probeHttp(s.port, host)
        if (!page) return null
        const urlHost = host === '127.0.0.1' || host === '::1' ? 'localhost' : host.includes(':') ? `[${host}]` : host
        const server: LocalServer = {
          port: s.port,
          url: `http://${urlHost}:${s.port}`,
          pid: s.pid,
          command: s.command,
          cwd: cwds.get(s.pid),
          title: page.title,
          host
        }
        return server
      })
    )
    return probed.filter((s): s is LocalServer => s !== null)
  })()
  const entry: { at: number; servers: Promise<LocalServer[]>; pending: boolean } = { at: now, servers, pending: true }
  cached = entry
  void servers
    .finally(() => {
      entry.pending = false
      entry.at = Date.now()
    })
    .catch(() => {})
  return servers
}

/** `ps` parent map, for matching a listener to the process tree Carbon spawned. */
export async function processParents(): Promise<Map<number, number>> {
  return parsePsParents(await run('ps', ['-A', '-o', 'pid=,ppid='], 3000))
}
