import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Read the user-level default model without treating model keys inside TOML
 * tables as the global default. Codex model ids are ordinary one-line strings,
 * so a narrow parser keeps this helper dependency-free and testable.
 */
export function parseCodexConfigModel(source: string): string | null {
  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    // A TOML table stays active for the rest of its section; a later `model`
    // key is therefore not top-level.
    if (line.startsWith('[')) break

    const match = /^model\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/.exec(line)
    if (!match) continue

    const value = match[1]
    if (value.startsWith("'")) return value.slice(1, -1)
    try {
      const parsed = JSON.parse(value) as unknown
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/** User-level model inherited by Codex when Carbon does not pin a model. */
export function readCodexConfigModel(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir()
): string | null {
  const codexHome = env.CODEX_HOME || join(userHome, '.codex')
  try {
    return parseCodexConfigModel(readFileSync(join(codexHome, 'config.toml'), 'utf8'))
  } catch {
    return null
  }
}
