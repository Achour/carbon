import {
  CANVAS_TOOL_INFO,
  CANVAS_TOOL_NAMES,
  runCanvasTool,
  type CanvasToolHost,
  type CanvasToolInput,
  type CanvasToolName
} from './canvasTools.ts'
import {
  PREVIEW_TOOL_INFO,
  PREVIEW_TOOL_NAMES,
  isPreviewSideEffect,
  previewPlanBlock,
  runPreviewTool,
  type PreviewToolHost,
  type PreviewToolName,
  type PreviewToolResult
} from './previewTools.ts'

/**
 * **One MCP server, `carbon`, for every provider.**
 *
 * The preview tools and the canvas tools used to be two servers, which cost
 * Codex and Grok *two* child processes apiece — each one an Electron binary
 * running as node (measured: ~68 MB RSS each) whose entire job was to forward a
 * JSON-RPC call to a loopback HTTP server inside the very process that spawned
 * it. Both CLIs speak streamable-HTTP MCP (verified against codex-cli 0.155.0
 * and grok 1.0.34), so the bridge now *is* the server and the children are
 * gone. Claude keeps its in-process `createSdkMcpServer` — it was never paying
 * for a child — but it is built from this same table, so all three providers
 * see one server with one set of tool names.
 *
 * That naming is the whole reason this module exists rather than two: a tool is
 * `mcp__carbon__preview_start`, not `mcp__preview__start`, and every layer that
 * decides something from a tool's name (the permission gate, the transcript's
 * labels, Grok's normalizer) has to agree with the thing that declared it. The
 * declaration lives here and everything else is derived.
 *
 * Dependency-free on purpose — `node:*` only, no Electron — so `node --test`
 * runs it straight off the `.ts`.
 */
export const CARBON_MCP_NAME = 'carbon'

/** MCP's own version; overridden by whatever the client asks for. */
const PROTOCOL = '2025-06-18'

export type CarbonToolRef =
  | { kind: 'preview'; name: PreviewToolName }
  | { kind: 'canvas'; name: CanvasToolName }

/** Every tool the server can advertise, preview first. */
export const CARBON_TOOL_REFS: readonly CarbonToolRef[] = [
  ...PREVIEW_TOOL_NAMES.map((name) => ({ kind: 'preview' as const, name })),
  ...CANVAS_TOOL_NAMES.map((name) => ({ kind: 'canvas' as const, name }))
]

/** The tool's own name inside the server: `preview_start`, `canvas_write`. */
export function carbonToolName(ref: CarbonToolRef): string {
  return `${ref.kind}_${ref.name}`
}

/** What every provider calls it once the server is namespaced. */
export function carbonToolId(ref: CarbonToolRef): string {
  return `mcp__${CARBON_MCP_NAME}__${carbonToolName(ref)}`
}

/**
 * The reverse, and deliberately forgiving.
 *
 * A tool arrives spelled `preview_start` from the MCP wire, but Grok reports
 * its own calls through `use_tool` and has spelled the namespace more than one
 * way (`carbon__preview_start`, `carbon/preview_start`, the full
 * `mcp__carbon__preview_start`). Accepting the suffix is what keeps one tool
 * from rendering as a generic wrench on one provider — the asymmetry this
 * codebase keeps ruling out — and the cost of the looseness is bounded: it only
 * ever runs on calls already routed to this server, or on Grok's own names.
 */
export function parseCarbonTool(raw: string | undefined): CarbonToolRef | undefined {
  if (!raw) return undefined
  const key = raw.trim().toLowerCase().replace(/[-.]/g, '_')
  const match = /(?:^|_|\/|:)(preview|canvas)_([a-z_]+)$/.exec(key)
  if (!match) return undefined
  const [, kind, name] = match
  if (kind === 'preview') {
    const found = PREVIEW_TOOL_NAMES.find((candidate) => candidate === name)
    return found ? { kind: 'preview', name: found } : undefined
  }
  const found = CANVAS_TOOL_NAMES.find((candidate) => candidate === name)
  return found ? { kind: 'canvas', name: found } : undefined
}

/** True for a fully-namespaced id belonging to this server. */
export function isCarbonToolId(name: string): boolean {
  return name.startsWith(`mcp__${CARBON_MCP_NAME}__`)
}

/**
 * The only carbon tools that touch anything outside the app: starting and
 * stopping a dev server. Everything else — a screenshot, a console read, a
 * canvas write — is app-local, which is why the permission gate can allow the
 * rest without asking. A *table*, not a prefix test: a prefix says "this server
 * is safe" and would silently auto-allow the next tool added to it.
 */
export function isCarbonSideEffect(name: string): boolean {
  const ref = parseCarbonTool(name)
  return ref?.kind === 'preview' && isPreviewSideEffect(ref.name)
}

export type CarbonToolSchema = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * The wire schema, derived from the two tool tables rather than written out
 * again. `canvas` is optional because the canvas host is: a build without one
 * should advertise the preview half rather than a tool that answers "not
 * available" to every call.
 */
export function carbonToolList(opts: { canvas?: boolean } = {}): CarbonToolSchema[] {
  const canvas = opts.canvas !== false
  return CARBON_TOOL_REFS.filter((ref) => canvas || ref.kind === 'preview').map((ref) => {
    if (ref.kind === 'preview') {
      const info = PREVIEW_TOOL_INFO[ref.name]
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      if (info.url) {
        properties.url = { type: 'string', description: 'The URL to load in the preview.' }
        required.push('url')
      }
      return {
        name: carbonToolName(ref),
        description: info.description,
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) }
      }
    }
    const info = CANVAS_TOOL_INFO[ref.name]
    const entries = Object.entries(info.params)
    const required = entries.filter(([, p]) => p.required).map(([key]) => key)
    return {
      name: carbonToolName(ref),
      description: info.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          entries.map(([key, p]) => [key, { type: p.type, description: p.description }])
        ),
        ...(required.length ? { required } : {})
      }
    }
  })
}

/**
 * The server's tools as the MCP panel lists them. Grok has no way to report a
 * server's tools over ACP, so Carbon answers from the same table it declared —
 * which is the only honest answer available and stays right by construction.
 */
export function carbonMcpTools(): { name: string; description: string; readOnly: boolean }[] {
  return CARBON_TOOL_REFS.map((ref) => {
    const info = ref.kind === 'preview' ? PREVIEW_TOOL_INFO[ref.name] : CANVAS_TOOL_INFO[ref.name]
    return { name: carbonToolName(ref), description: info.description, readOnly: info.readOnly }
  })
}

/** The union of both tool tables' arguments. */
export type CarbonToolInput = CanvasToolInput & { url?: string }

/**
 * Coerced in one place rather than at each call site: the arguments arrive as
 * untyped JSON from a model, and a field picked in the HTTP path but forgotten
 * in Claude's is precisely how the two providers came to be told different
 * things about one tool before.
 */
export function carbonToolInput(raw: unknown): CarbonToolInput {
  const input = (raw ?? {}) as Record<string, unknown>
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined
  return {
    url: str(input.url),
    title: str(input.title),
    html: str(input.html),
    id: str(input.id),
    old_string: str(input.old_string),
    new_string: str(input.new_string),
    replace_all: input.replace_all === true
  }
}

/** What a session needs to answer a call: where it runs, and for whom. */
export interface CarbonToolContext {
  cwd: string
  project: string
  chatId?: string | null
  /**
   * Live rather than fixed at spawn. Plan mode used to be pinned into the
   * child's environment, so Codex could only learn about a change by rebuilding
   * its thread and Grok never learned at all — its preview tools ran in plan
   * mode where Claude's were refused.
   */
  plan?: () => boolean
}

export interface CarbonToolHosts {
  preview: PreviewToolHost
  canvas?: CanvasToolHost
}

export type CarbonToolResponse =
  | ({ ok: true } & PreviewToolResult)
  | { ok: false; error: string }

export async function runCarbonTool(
  hosts: CarbonToolHosts,
  ctx: CarbonToolContext,
  raw: string,
  input: CarbonToolInput = {}
): Promise<CarbonToolResponse> {
  const ref = parseCarbonTool(raw)
  if (!ref) return { ok: false, error: `Unknown tool: ${raw || '(missing)'}` }
  if (ref.kind === 'preview') {
    const blocked = previewPlanBlock(ref.name, ctx.plan?.() === true)
    if (blocked) return { ok: false, error: blocked }
    if (!ctx.cwd) return { ok: false, error: 'cwd is required.' }
    return { ok: true, ...(await runPreviewTool(hosts.preview, ctx.cwd, ref.name, input)) }
  }
  if (!hosts.canvas) return { ok: false, error: 'Canvas is not available.' }
  if (!ctx.project) return { ok: false, error: 'project is required.' }
  return {
    ok: true,
    ...runCanvasTool(hosts.canvas, { project: ctx.project, chatId: ctx.chatId ?? null }, ref.name, input)
  }
}

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * Everything but `tools/call`, which is async and has its own function.
 *
 * `null` means "nothing to answer": a notification (no id), or a call the HTTP
 * layer handles itself. An unknown *method* is answered `-32601` rather than
 * ignored — Grok opens with `server/discover`, which is not MCP at all, and
 * both it and Codex carry on to `initialize` after the error (verified against
 * the running CLIs; a silent drop would leave the request outstanding).
 */
export function handleMcpMessage(
  message: JsonRpcRequest,
  opts: { canvas?: boolean } = {}
): JsonRpcResponse | null {
  if (!message.method || message.id == null) return null
  const id = message.id
  if (message.method === 'initialize') {
    const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: CARBON_MCP_NAME, version: '1.0.0' }
      }
    }
  }
  if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: carbonToolList(opts) } }
  }
  if (message.method === 'tools/call') return null
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unknown method: ${message.method}` }
  }
}

export async function handleMcpCall(
  message: JsonRpcRequest,
  callTool: (name: string, input: CarbonToolInput) => Promise<CarbonToolResponse>
): Promise<JsonRpcResponse> {
  const id = message.id ?? null
  const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown }
  const name = typeof params.name === 'string' ? params.name : ''
  try {
    const result = await callTool(name, carbonToolInput(params.arguments))
    if (!result.ok) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: result.error }], isError: true }
      }
    }
    if (result.kind === 'image') {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'image', data: result.data, mimeType: result.mimeType }] }
      }
    }
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }] } }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true
      }
    }
  }
}

/** ACP `session/new` MCP server. Grok's `initialize` advertises `http`. */
export interface HttpMcpServer {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

export function carbonAcpServer(url: string, token: string): HttpMcpServer {
  return {
    type: 'http',
    name: CARBON_MCP_NAME,
    url,
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
  }
}

/**
 * Codex's `config.mcp_servers` overlay.
 *
 * `http_headers` rather than `bearer_token_env_var`: both work, but the header
 * rides the `thread/start` overlay over the app server's stdin, where the env
 * var would have to be planted on the app-server process at spawn — a second
 * place to keep in sync, and one that is live in `ps` for the whole session.
 */
export function carbonCodexConfig(url: string, token: string): Record<string, unknown> {
  return {
    mcp_servers: {
      [CARBON_MCP_NAME]: {
        url,
        http_headers: { Authorization: `Bearer ${token}` }
      }
    }
  }
}
