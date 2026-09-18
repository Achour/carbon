/**
 * The icon a user *chose* for a project, when the scan's answer is not the one
 * they want.
 *
 * `main/projects.ts` resolves a project's mark from what is on disk, which is
 * right for almost every repo and wrong for a handful in a way no heuristic
 * fixes: a monorepo whose root has no icon, a private repo whose only image is
 * a client's logo, a project whose favicon is a placeholder the team never
 * replaced. So the scan gets an override above it, and the override is a file
 * rather than a setting.
 *
 * **The directory is the record.** `userData/project-icons/<key>.<ext>` exists,
 * or the project has no override — there is no second copy of that fact in
 * `settings.json` to drift out of step with it, no migration when the shape
 * changes, and `rm -rf` on the folder is a complete reset. The key is a hash of
 * the project root, so renaming the folder in Settings keeps the icon and
 * *moving* the project on disk correctly loses it (it is a different project by
 * every other definition too).
 *
 * The chosen file is **copied**, not referenced. A path into `~/Downloads` is a
 * mark that vanishes the next time the user tidies up, and a path inside the
 * repo is one that vanishes on the next branch switch; neither failure would
 * say anything, it would just be two grey letters again.
 *
 * `<key>.none` — an empty file — is the third state: *use the initials*, chosen
 * deliberately over an icon the scan did find. Absent would mean "automatic",
 * which is what the user is overriding.
 *
 * **`node:*` only**, and the directory is injected rather than asked for. The
 * scan in `projects.ts` reads an override before it reads the folder, so this
 * sits on that module's import graph — and `test/projectIdentity.test.ts`
 * imports `parseRemoteUrl` from it, which `node --test` runs as `.ts` with no
 * bundler. One `import … from 'electron'` anywhere underneath and that test
 * stops at a SyntaxError. The half that needs a file dialog and an image
 * resizer lives in `projectIconPicker.ts` — the same split `favicons.ts`
 * already keeps against `faviconCache.ts`.
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { iconDataUri } from './iconCandidates.ts'

/**
 * What a stored override resolves to.
 *
 * `null` is "no override" and `'initials'` is the deliberate absence of one —
 * the distinction the `.none` sentinel exists to carry.
 */
export type ProjectIconOverride = { uri: string } | 'initials' | null

/**
 * Where the overrides live, set once at startup from `userData`.
 *
 * Unset answers "no override" rather than throwing: every caller of this has a
 * fallback ready — the scan, then the initials — and none of them should have
 * to know the directory was wired at all.
 */
let base: string | null = null

export function configureProjectIcons(userDataDir: string): void {
  base = join(userDataDir, 'project-icons')
  listing = null
}

/** A project root as a filename. Short: this is a namespace of at most a few
 * dozen entries, so 16 hex characters is collision-free by a wide margin. */
function key(root: string): string {
  return createHash('sha1').update(root).digest('hex').slice(0, 16)
}

/**
 * The override files, keyed by hash — one `readdir` for every project on the
 * page rather than one `stat` per project per extension.
 *
 * Rebuilt on every write and cleared by `clearIconCache`, so Recheck picks up
 * a file someone dropped in by hand. `null` means "not read yet"; an empty map
 * means "read, and nobody has an override".
 */
let listing: Map<string, string> | null = null

async function files(): Promise<Map<string, string>> {
  if (listing) return listing
  const out = new Map<string, string>()
  const names = base ? await readdir(base).catch(() => [] as string[]) : []
  for (const name of names) {
    const stem = name.slice(0, name.length - extname(name).length)
    // First wins, and a write removes the old extension before adding the new
    // one, so two files per key is a state this cannot normally be in.
    if (stem && !out.has(stem)) out.set(stem, name)
  }
  listing = out
  return out
}

export function clearProjectIconOverrides(): void {
  listing = null
}

/** The override for a project: a `data:` URI, the initials sentinel, or null. */
export async function projectIconOverride(root: string): Promise<ProjectIconOverride> {
  const name = (await files()).get(key(root))
  if (!name || !base) return null
  if (name.endsWith('.none')) return 'initials'
  const path = join(base, name)
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return null
  const uri = iconDataUri(bytes, path)
  return uri ? { uri } : null
}

async function replace(root: string, ext: string, bytes: Buffer | null): Promise<void> {
  if (!base) return
  await mkdir(base, { recursive: true })
  const existing = (await files()).get(key(root))
  if (existing) await rm(join(base, existing), { force: true })
  await writeFile(join(base, `${key(root)}${ext}`), bytes ?? Buffer.alloc(0))
  listing = null
}

/** Store a normalized image as this project's mark. */
export async function saveProjectIcon(root: string, ext: string, bytes: Buffer): Promise<void> {
  await replace(root, ext, bytes)
}

/** Draw this project's initials, whatever the scan found. */
export async function useProjectInitials(root: string): Promise<void> {
  await replace(root, '.none', null)
}

/** Back to whatever the scan finds in the folder. */
export async function clearProjectIcon(root: string): Promise<void> {
  if (!base) return
  const existing = (await files()).get(key(root))
  if (existing) await rm(join(base, existing), { force: true })
  listing = null
}
