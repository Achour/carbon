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
    console.warn(`[preview] MCP script missing at ${script}; Grok will not get preview tools.`)
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


