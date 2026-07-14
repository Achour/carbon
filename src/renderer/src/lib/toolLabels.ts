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
