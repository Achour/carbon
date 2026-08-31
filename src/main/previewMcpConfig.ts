import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PreviewBridgeHandle } from './previewBridge.ts'

/** ACP `session/new` stdio MCP server — env is a list, not a map. */
export interface StdioMcpServer {
  name: string
  command: string
  args: string[]
  env: { name: string; value: string }[]
}

export const PREVIEW_MCP_NAME = 'preview'
export const CANVAS_MCP_NAME = 'canvas'

export function previewMcpScriptPath(from = import.meta.url): string {
  return join(dirname(fileURLToPath(from)), 'previewMcp.js')
}

/**
 * The stdio MCP server Carbon asks Grok to spawn. The child talks JSON-RPC on
 * its pipes and POSTs each tool to the loopback bridge — Grok cannot load an
 * in-process server the way the Claude SDK can.
 */
export function carbonPreviewMcpServers(
  cwd: string,
  bridge: PreviewBridgeHandle,
  opts: { scriptPath?: string; execPath?: string } = {}
): StdioMcpServer[] {
  const script = opts.scriptPath ?? previewMcpScriptPath()
  if (!existsSync(script)) {
    console.warn(`[preview] MCP script missing at ${script}; Grok/Codex will not get preview tools.`)
    return []
  }
  const extra: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    CARBON_PREVIEW_URL: bridge.url,
    CARBON_PREVIEW_TOKEN: bridge.token,
    CARBON_PREVIEW_CWD: cwd
  }
  const env = Object.entries({ ...process.env, ...extra })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, value]) => ({ name, value }))
  return [
    {
      name: PREVIEW_MCP_NAME,
      command: opts.execPath ?? process.execPath,
      args: [script, '--stdio'],
      env
    }
  ]
}

/** Codex `config.mcp_servers` overlay — one named table; env is a map. */
export function carbonPreviewCodexMcp(
  cwd: string,
  bridge: PreviewBridgeHandle,
  opts: { scriptPath?: string; execPath?: string; plan?: boolean } = {}
): Record<string, unknown> | undefined {
  const servers = carbonPreviewMcpServers(cwd, bridge, opts)
  const server = servers[0]
  if (!server) return undefined
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    CARBON_PREVIEW_URL: bridge.url,
    CARBON_PREVIEW_TOKEN: bridge.token,
    CARBON_PREVIEW_CWD: cwd
  }
  if (opts.plan) env.CARBON_PREVIEW_PLAN = '1'
  return {
    mcp_servers: {
      [PREVIEW_MCP_NAME]: {
        command: server.command,
        args: server.args,
        env
      }
    }
  }
}



/**
 * The canvas server's environment. It rides the same bridge and the same child
 * script as the preview one — `CARBON_MCP_SERVER` is what selects the tool
 * table — so the only additions are the two facts the canvas tools need and the
 * preview tools do not.
 *
 * `CARBON_CANVAS_PROJECT` is the repo root, fixed at spawn. A worktree chat's
 * cwd is a directory `finishWorktree` deletes, so keying a canvas on it would
 * lose the document with the branch; deriving the root per call would put git
 * work on every write.
 */
function canvasEnv(
  bridge: PreviewBridgeHandle,
  ctx: { cwd: string; project: string; chatId?: string | null }
): Record<string, string> {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    CARBON_MCP_SERVER: CANVAS_MCP_NAME,
    CARBON_PREVIEW_URL: bridge.url,
    CARBON_PREVIEW_TOKEN: bridge.token,
    CARBON_PREVIEW_CWD: ctx.cwd,
    CARBON_CANVAS_PROJECT: ctx.project
  }
  if (ctx.chatId) env.CARBON_CANVAS_CHAT = ctx.chatId
  return env
}

/** ACP `mcpServers` entry giving Grok this project's canvas tools. */
export function carbonCanvasMcpServers(
  ctx: { cwd: string; project: string; chatId?: string | null },
  bridge: PreviewBridgeHandle,
  opts: { scriptPath?: string; execPath?: string } = {}
): StdioMcpServer[] {
  const script = opts.scriptPath ?? previewMcpScriptPath()
  if (!existsSync(script)) return []
  const extra = canvasEnv(bridge, ctx)
  const env = Object.entries({ ...process.env, ...extra })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, value]) => ({ name, value }))
  return [{ name: CANVAS_MCP_NAME, command: opts.execPath ?? process.execPath, args: [script, '--stdio'], env }]
}

/** Codex `config.mcp_servers.canvas` overlay. */
export function carbonCanvasCodexMcp(
  ctx: { cwd: string; project: string; chatId?: string | null },
  bridge: PreviewBridgeHandle,
  opts: { scriptPath?: string; execPath?: string } = {}
): Record<string, unknown> | undefined {
  const server = carbonCanvasMcpServers(ctx, bridge, opts)[0]
  if (!server) return undefined
  return {
    mcp_servers: {
      [CANVAS_MCP_NAME]: {
        command: server.command,
        args: server.args,
        env: canvasEnv(bridge, ctx)
      }
    }
  }
}
