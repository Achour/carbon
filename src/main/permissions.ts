import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OpResult, PermissionRule } from '@shared/types'

/**
 * Reads and edits the persisted permission rules the agent SDK loads from
 * settings files (settingSources: user/project/local). "Always allow" in the UI
 * writes to the project's settings.local.json via the SDK; this module lets the
 * UI show those rules and remove them again.
 */

type Behavior = PermissionRule['behavior']
const BEHAVIORS: Behavior[] = ['allow', 'deny', 'ask']

interface SettingsFile {
  permissions?: Partial<Record<Behavior, string[]>>
}

/** Absolute path of each settings file for a project. */
function filePaths(cwd: string): Record<PermissionRule['source'], string> {
  return {
    user: join(homedir(), '.claude', 'settings.json'),
    project: join(cwd, '.claude', 'settings.json'),
    local: join(cwd, '.claude', 'settings.local.json')
  }
}

function readJson(path: string): SettingsFile | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as SettingsFile
  } catch {
    return null
  }
}

/** Merged allow/deny/ask rules across user, project and local settings files. */
export function getPermissionRules(cwd: string): PermissionRule[] {
  const paths = filePaths(cwd)
  const rules: PermissionRule[] = []
  for (const source of ['user', 'project', 'local'] as const) {
    const data = readJson(paths[source])
    if (!data?.permissions) continue
    for (const behavior of BEHAVIORS) {
      for (const value of data.permissions[behavior] ?? []) {
        rules.push({ value, behavior, source })
      }
    }
  }
  return rules
}

/**
 * Removes a rule from a project settings file. Only local/project scope is
 * editable from the UI — the user-level file is shown read-only.
 */
export function removePermissionRule(cwd: string, rule: PermissionRule): OpResult {
  if (rule.source === 'user') {
    return { ok: false, error: 'User-level rules can only be edited in ~/.claude/settings.json.' }
  }
  const path = filePaths(cwd)[rule.source]
  const data = readJson(path)
  const list = data?.permissions?.[rule.behavior]
  if (!data || !list) return { ok: false, error: 'Rule not found.' }
  const next = list.filter((v) => v !== rule.value)
  if (next.length === list.length) return { ok: false, error: 'Rule not found.' }
  data.permissions![rule.behavior] = next
  try {
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
