import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
// Relative and .ts-extensioned, like providerCli.ts's own import of the shared
// types: `test/lspFrames.test.ts` runs this file directly under `node --test`,
// with no bundler to resolve an alias.
import { isExecutable, onPath } from './providerCli.ts'
import type { LspServerStatus } from '@shared/types'

/**
 * Language servers, for go-to-definition, hover, completion and diagnostics in
 * the file editor.
 *
 * This is the same shape as `grokAcp.ts` — spawn a process, speak JSON-RPC over
 * its pipes — with one deliberate difference: **main does no JSON-RPC at all.**
 * `@codemirror/lsp-client` runs the protocol in the renderer, so everything here
 * is a framed pipe. That keeps the protocol logic next to the editor that needs
 * it, and keeps the main process off the critical path of every keystroke's
 * `didChange` beyond a write to a socket.
 *
 * Like the provider CLIs, **Carbon ships no servers.** A server the user has is
 * a server they chose and keep updated; one we vendored would be stale by the
 * next release. Resolution mirrors `providerCli.ts` — project-local first
 * (a repo pinning its own `typescript-language-server` is the version its code
 * is written against), then PATH, then the usual install prefixes.
 */

interface ServerSpec {
  /** Binary name, looked up in node_modules/.bin, then PATH, then prefixes. */
  bin: string
  args: string[]
  /** Shown when the binary is missing. */
  install: string
}

/**
 * Candidate servers per LSP language id, best first. The first one that
 * resolves wins, so a project with `vtsls` gets it and everyone else gets
 * `typescript-language-server`.
 *
 * Note this is `typescript-language-server`, **not** `tsserver`: tsserver speaks
 * TypeScript's own protocol and would fail `initialize` outright.
 */
const SERVERS: Record<string, ServerSpec[]> = {
  typescript: tsServers(),
  typescriptreact: tsServers(),
  javascript: tsServers(),
  javascriptreact: tsServers(),
  python: [
    { bin: 'pyright-langserver', args: ['--stdio'], install: 'npm install -g pyright' },
    { bin: 'pylsp', args: [], install: 'pipx install python-lsp-server' }
  ],
  rust: [{ bin: 'rust-analyzer', args: [], install: 'rustup component add rust-analyzer' }],
  go: [{ bin: 'gopls', args: [], install: 'go install golang.org/x/tools/gopls@latest' }],
  ruby: [{ bin: 'solargraph', args: ['stdio'], install: 'gem install solargraph' }],
  json: [
    {
      bin: 'vscode-json-language-server',
      args: ['--stdio'],
      install: 'npm install -g vscode-langservers-extracted'
    }
  ]
}

function tsServers(): ServerSpec[] {
  return [
    { bin: 'vtsls', args: ['--stdio'], install: 'npm install -g @vtsls/language-server' },
    {
      bin: 'typescript-language-server',
      args: ['--stdio'],
      install: 'npm install -g typescript-language-server typescript'
    }
  ]
}

/**
 * A project's own `node_modules/.bin` outranks PATH here, which is the reverse
 * of `providerCli.ts` — and for the same underlying reason. There, the user's
 * shim is the right answer because the CLI is a *tool they run*; here the server
 * has to agree with the TypeScript version the repo compiles against, and that
 * version is the one in its lockfile.
 */
function resolveServer(root: string, spec: ServerSpec): string | null {
  const local = join(root, 'node_modules', '.bin', spec.bin)
  if (isExecutable(local)) return local
  const found = onPath(spec.bin, process.env)
  if (found) return found
  for (const prefix of INSTALL_PREFIXES) {
    const candidate = join(prefix, spec.bin)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/** Where a hand-installed server usually lands, consulted after PATH. */
const INSTALL_PREFIXES = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(process.env.HOME ?? '', '.local/bin')
]

interface Server {
  id: string
  /** `${root} ${languageId}` — carried so teardown needs no reverse scan. */
  key: string
  proc: ChildProcessWithoutNullStreams
  /** Incoming bytes not yet split into whole messages. */
  buf: Buffer
  /** Pending shutdown after the client released it. */
  idleTimer: NodeJS.Timeout | null
}

/** How long a released server is kept alive before being shut down. */
const IDLE_MS = 5 * 60_000

/**
 * Owns the language-server child processes.
 *
 * A class taking its emitter in the constructor, like `TerminalManager` and
 * `PreviewManager` — the two other modules in main that own live child
 * processes — rather than module state wired by a setter, which left the
 * emitter null for a window after load and gave `index.ts`'s teardown block a
 * fifth idiom.
 *
 * There is deliberately **no refcount**. The renderer caches one client per
 * `(root, language)` (`lib/lspClient.ts`), so it asks for a server once and
 * releases it once; a count here would have described a lifecycle main never
 * sees. One owner: the renderer decides when a server is done, this decides how
 * long to wait before believing it.
 */
export class LspManager {
  private readonly servers = new Map<string, Server>()
  private readonly byId = new Map<string, Server>()
  private nextId = 1
  private readonly emit: (id: string, message: string) => void

  // An explicit field rather than a parameter property: `test/lspFrames.test.ts`
  // runs this file directly under `node --test`, whose type-stripping mode
  // rejects the shorthand.
  constructor(emit: (id: string, message: string) => void) {
    this.emit = emit
  }

  /**
   * Start (or reuse) a server for a project root and language.
   *
   * Keyed by `(root, languageId)` rather than by file: one `tsserver` per
   * project is what makes cross-file jumps possible at all, and starting one per
   * open tab would run several full type-checks of the same program side by side.
   */
  ensure(root: string, languageId: string): LspServerStatus {
    const key = `${root} ${languageId}`
    const existing = this.servers.get(key)
    if (existing) {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer)
        existing.idleTimer = null
      }
      return { ok: true, id: existing.id }
    }

    const specs = SERVERS[languageId]
    if (!specs) return { ok: false, reason: 'unsupported' }

    for (const spec of specs) {
      const bin = resolveServer(root, spec)
      if (!bin) continue
      try {
        const proc = spawn(bin, spec.args, {
          cwd: root,
          // A server inherits the hydrated PATH for the same reason the provider
          // CLIs do: a Dock-launched app has none of the user's shell setup, and
          // several of these servers shell out to a toolchain themselves.
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe']
        }) as ChildProcessWithoutNullStreams
        const id = `lsp${this.nextId++}`
        const server: Server = { id, key, proc, buf: Buffer.alloc(0), idleTimer: null }
        this.servers.set(key, server)
        this.byId.set(id, server)

        proc.stdout.on('data', (chunk: Buffer) => {
          server.buf = server.buf.length === 0 ? chunk : Buffer.concat([server.buf, chunk])
          const { messages, rest } = splitFrames(server.buf)
          server.buf = rest
          for (const message of messages) this.emit(id, message)
        })
        // Servers are chatty on stderr (progress, indexing). Swallow it rather
        // than surfacing it: none of it is actionable in a GUI, and gopls in
        // particular writes megabytes of it during a cold index.
        proc.stderr.resume()
        const gone = (): void => this.forget(server)
        proc.on('exit', gone)
        proc.on('error', gone)
        return { ok: true, id }
      } catch {
        // Try the next candidate.
      }
    }
    return { ok: false, reason: 'not-installed', install: specs[0].install, bin: specs[0].bin }
  }

  send(id: string, message: string): void {
    const server = this.byId.get(id)
    if (!server || server.proc.exitCode !== null) return
    const body = Buffer.from(message, 'utf8')
    server.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    server.proc.stdin.write(body)
  }

  /**
   * The client is done with this server. It stays up briefly: reopening a
   * project a moment after closing it is common, and a cold `tsserver` on a
   * large repo is seconds of no completions.
   */
  release(id: string): void {
    const server = this.byId.get(id)
    if (!server || server.idleTimer) return
    server.idleTimer = setTimeout(() => this.stop(server), IDLE_MS)
    server.idleTimer.unref?.()
  }

  /** Quit: language servers are child processes and must not outlive the app. */
  disposeAll(): void {
    for (const server of [...this.servers.values()]) this.stop(server)
  }

  private stop(server: Server): void {
    this.forget(server)
    try {
      server.proc.kill()
    } catch {
      // Already gone.
    }
  }

  private forget(server: Server): void {
    if (server.idleTimer) clearTimeout(server.idleTimer)
    if (this.servers.get(server.key) === server) this.servers.delete(server.key)
    this.byId.delete(server.id)
  }
}

/**
 * Split a byte stream into whole LSP messages, returning them plus the bytes
 * that are not yet a complete frame.
 *
 * A message can be split across several `data` events and several messages can
 * arrive in one — both are normal, not edge cases. `Content-Length` counts
 * **bytes**, so all of this stays on the Buffer; slicing the decoded string
 * would be off by one per non-ASCII character, which is every file with an
 * emoji or a curly quote in it.
 *
 * Pure and dependency-free so `test/lspFrames.test.ts` can run it directly.
 */
export function splitFrames(buf: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = []
  let rest = buf
  for (;;) {
    const headerEnd = rest.indexOf('\r\n\r\n')
    if (headerEnd === -1) break
    const header = rest.subarray(0, headerEnd).toString('ascii')
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (!match) {
      // Unparseable frame — drop the header and resync rather than stalling the
      // stream forever on bytes that will never become a message.
      rest = rest.subarray(headerEnd + 4)
      continue
    }
    const length = Number.parseInt(match[1], 10)
    const start = headerEnd + 4
    if (rest.length < start + length) break
    messages.push(rest.subarray(start, start + length).toString('utf8'))
    rest = rest.subarray(start + length)
  }
  return { messages, rest }
}
