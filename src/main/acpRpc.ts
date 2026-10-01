import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * JSON-RPC 2.0 over a child's stdio — the transport every ACP agent speaks.
 *
 * Grok's client (`grokAcp.ts`) predates this and still carries its own copy;
 * Antigravity is the second ACP backend and the first to use this one. It knows
 * nothing about ACP's *methods*: requests, replies and notifications go in and
 * out, and the agent-to-client requests (permission prompts, ext methods) are
 * handed to `onRequest`, whose answer — or thrown error — becomes the reply.
 *
 * Dependency-free (`node:*` only), so `node --test` can drive it against a
 * fake agent.
 */

export type JsonRpcId = string | number

interface RpcMessage {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** A JSON-RPC error the agent answered with, keeping its `code` and `data`. */
export class AcpRpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

/** Thrown by `onRequest` to answer the agent with a specific error code. */
export class AcpMethodNotFound extends Error {}

export interface AcpRpcOptions {
  /** Shown in errors ("Antigravity exited unexpectedly"). */
  label: string
  command: string
  args?: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  onNotification(method: string, params: unknown): void
  /** Answer an agent→client request. Throw `AcpMethodNotFound` for unknown methods. */
  onRequest(method: string, params: unknown): Promise<unknown>
  /** Each stderr line. The agent logs there; some also print sign-in links. */
  onStderr?(line: string): void
  /** The process is gone. `error` is null for an exit Carbon asked for. */
  onExit(error: Error | null): void
}

export class AcpRpc {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private closing = false
  private exited = false

  private readonly options: AcpRpcOptions

  constructor(options: AcpRpcOptions) {
    this.options = options
  }

  get alive(): boolean {
    return this.child !== null && !this.exited && !this.closing
  }

  start(): void {
    const { command, args = [], cwd, env, label } = this.options
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    createInterface({ input: child.stderr }).on('line', (line) => this.options.onStderr?.(line))
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code, signal) => {
      this.exited = true
      this.fail(
        this.closing
          ? null
          : new Error(
              `${label} exited unexpectedly${code != null ? ` (code ${code})` : ''}${
                signal ? ` (${signal})` : ''
              }.`
            )
      )
    })
    // A write to a pipe whose reader died raises EPIPE on the stream, not at
    // the call site; unhandled, it would take the main process down with it.
    child.stdin.on('error', () => {})
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      if (!this.alive) {
        reject(new Error(`${this.options.label} is not running.`))
        return
      }
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject
      })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params: unknown): void {
    try {
      this.write({ jsonrpc: '2.0', method, params })
    } catch {
      // A dead process has nothing left to tell.
    }
  }

  dispose(): void {
    if (this.closing) return
    this.closing = true
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error(`${this.options.label} session was closed.`))
    }
    this.pending.clear()
    const child = this.child
    if (!child || this.exited) return
    try {
      child.stdin.end()
    } catch {
      // Already torn down.
    }
    child.kill()
  }

  private write(message: RpcMessage): void {
    const stdin = this.child?.stdin
    if (!stdin?.writable) throw new Error(`${this.options.label} is not running.`)
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  private fail(error: Error | null): void {
    const waiters = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of waiters)
      waiter.reject(error ?? new Error(`${this.options.label} session ended.`))
    if (!this.closing) this.options.onExit(error)
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      // A stray non-JSON line (a library printing to stdout) is not protocol.
      return
    }
    if (message.id != null && !message.method) {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) {
        waiter.reject(
          new AcpRpcError(message.error.code, message.error.message, message.error.data)
        )
      } else {
        waiter.resolve(message.result)
      }
      return
    }
    if (message.method && message.id != null) {
      void this.answer(message.id, message.method, message.params)
      return
    }
    if (message.method) this.options.onNotification(message.method, message.params)
  }

  private async answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    let reply: RpcMessage
    try {
      reply = {
        jsonrpc: '2.0',
        id,
        result: (await this.options.onRequest(method, params)) ?? null
      }
    } catch (error) {
      reply =
        error instanceof AcpMethodNotFound
          ? {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32601,
                message: `Carbon does not implement ${method}.`
              }
            }
          : {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error)
              }
            }
    }
    try {
      this.write(reply)
    } catch {
      // The agent exited while the user was deciding; nobody is left to hear.
    }
  }
}
