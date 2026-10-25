/**
 * A new, empty project folder, for a phone that has no folder picker.
 *
 * The desktop starts a project from the system's open dialog, which can make a
 * folder anywhere. A phone cannot see the Mac's disk, so it names a folder and
 * picks where it goes from the folders that already hold projects
 * (`RemoteAccess.knownParent`). This module is the half that touches the disk:
 * one plain name, one level down, never over something already there.
 *
 * Dependency-free (only `node:*`) so `node --test` runs it directly.
 */

import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export type NewProjectResult = { ok: true; path: string } | { ok: false; error: string }

/**
 * Why a name cannot be a project folder, or null when it can. One path
 * segment, no hidden folder, nothing the Finder would choke on.
 */
export function projectNameError(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Give the project a name.'
  if (n === '.' || n === '..' || n.includes('/') || n.includes('\\') || n.includes('\0')) {
    return 'A project name cannot contain slashes.'
  }
  if (n.startsWith('.')) return 'A project name cannot start with a dot.'
  if (n.includes(':')) return 'A project name cannot contain a colon.'
  if (n.length > 100) return 'That name is too long.'
  return null
}

/** Make `parent/name`, refusing a folder that already exists. */
export async function createProjectFolder(parent: string, name: string): Promise<NewProjectResult> {
  const problem = projectNameError(name)
  if (problem) return { ok: false, error: problem }
  if (!isAbsolute(parent)) return { ok: false, error: 'That location is not a folder on the Mac.' }
  const path = join(parent, name.trim())
  try {
    // Not recursive: the parent must exist, and an existing folder is an error
    // rather than silently becoming "the new project".
    await mkdir(path)
    return { ok: true, path }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return { ok: false, error: `There is already a folder named “${name.trim()}” there.` }
    if (code === 'ENOENT') return { ok: false, error: 'That location no longer exists on the Mac.' }
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'Carbon is not allowed to create a folder there.' }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
