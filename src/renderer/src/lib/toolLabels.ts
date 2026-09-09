export interface HumanizedCommand {
  label: string
  summary: string
}

function relative(path: string, cwd: string): string {
  const clean = path.replace(/^['"]|['"]$/g, '')
  return clean.startsWith(cwd + '/') ? clean.slice(cwd.length + 1) : clean
}

/** Remove the transport shell Codex wraps around commands shown in the UI. */
export function unwrapShellCommand(command: string): string {
  const match = /^\/bin\/(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/.exec(command.trim())
  if (!match) return command.trim()
  const wrapped = match[1].trim()
  if (
    wrapped.length >= 2 &&
    ((wrapped.startsWith("'") && wrapped.endsWith("'")) ||
      (wrapped.startsWith('"') && wrapped.endsWith('"')))
  ) {
    return wrapped.slice(1, -1)
  }
  return wrapped
}

function lastPath(command: string): string | undefined {
  const matches = [...command.matchAll(/(?:^|\s)(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/g)]
  const token = matches.at(-1)
  return token?.[1] ?? token?.[2] ?? token?.[3]
}

/** Produce a compact, human-first label while leaving the raw command in details. */
export function humanizeShellCommand(command: string, cwd: string): HumanizedCommand {
  const clean = unwrapShellCommand(command)
  const path = lastPath(clean)
  const rel = path ? relative(path, cwd) : clean

  if (/^sed\s+-n\b/.test(clean)) return { label: 'Read', summary: rel }
  if (/^rg\s+--files\b/.test(clean)) return { label: 'List files', summary: cwd.split('/').pop() ?? cwd }
  if (/^(?:rg|grep)\b/.test(clean)) return { label: 'Search', summary: clean.replace(/^(?:rg|grep)\s+/, '') }
  if (/^find\b/.test(clean)) return { label: 'Find files', summary: rel }
  if (/^mkdir\b/.test(clean)) return { label: 'Create folder', summary: rel }
  if (/^(?:cp|ditto)\b/.test(clean)) return { label: 'Copy', summary: rel }
  if (/^mv\b/.test(clean)) return { label: 'Move', summary: rel }
  if (/^rm\b/.test(clean)) return { label: 'Remove', summary: rel }
  if (/^(?:npm|npx|pnpm|yarn|bun)\b/.test(clean)) return { label: 'Run', summary: clean }
  if (/^git\b/.test(clean)) return { label: 'Git', summary: clean.slice(4) }

  return { label: 'Terminal', summary: clean }
}

/**
 * Grok's `use_tool` wrapper, unwrapped — or undefined when the call is not one.
 *
 * The CLI defers its whole MCP catalog behind a single `use_tool`, so a browser
 * click, a preview screenshot and a canvas read all arrive under *one* name
 * with the real tool in `tool_name` and its arguments in `tool_input`. Read at
 * face value that is a row labelled `use_tool` with a wrench beside it — the
 * same call drawn on Claude and Codex as a browser or a preview — which is
 * exactly the provider asymmetry the normalizing in `grokAcp.ts` exists to
 * remove, minus the tools it could not name because they are not Grok's.
 *
 * The answer is a *rename into the shape the renderer already knows*
 * (`mcp__<server>__<tool>`) rather than a case per server: `canvas__write`
 * becomes `mcp__canvas__write` and matches the case that was already there, and
 * a server nobody has heard of still lands on the generic MCP row under its own
 * name instead of under Grok's plumbing. `canvasWrite` keeps its own reading of
 * the wrapper — it answers "is this a canvas mutation" for grouping and for the
 * link, which is a question about the call rather than about its name.
 */
export function unwrapGrokTool(
  name: string,
  input: Record<string, unknown>
): { name: string; input: Record<string, unknown> } | undefined {
  if (name !== 'use_tool') return undefined
  const tool = typeof input.tool_name === 'string' ? input.tool_name.trim() : ''
  if (!tool) return undefined
  const args = input.tool_input
  return {
    // Already-namespaced spellings pass through: the CLI has spelled this more
    // than one way, and `mcp__mcp__canvas__write` matches nothing at all.
    name: tool.startsWith('mcp__') ? tool : `mcp__${tool}`,
    input: args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  }
}
