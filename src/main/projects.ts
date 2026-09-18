/**
 * What Settings → Projects knows about a project folder.
 *
 * A "project" is already a thing the app has — `projectRoot(chat)` is the key
 * the sidebar groups by, the chat search labels with and ⌘N picks from — but it
 * has never been anything you could *look at*: it existed only as the folder
 * some chats happen to share. This module is the other half: given those roots,
 * what is actually there.
 *
 * **Split in two on cost, not on subject.** `projectOverview` is a `stat`, a
 * cached icon read, and two short git commands; `projectDetail` is every
 * worktree, every branch and a `status --porcelain` per tree. Answering both at
 * once would make opening a settings page spawn four-plus processes per project
 * — fifteen projects is sixty — for rows nobody has expanded. The page pays for
 * the list and then for whatever is opened.
 *
 * **Nothing here throws.** Every field degrades to `false` / `null` / `[]`,
 * because the whole point of the section is to be readable when a project is
 * broken: a folder that was deleted, a repo whose remote is a local path, a
 * worktree git still lists after someone `rm -rf`'d it. A page that reports a
 * missing folder by failing to render would be answering the wrong question.
 */

import { Buffer } from 'node:buffer'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  BranchRef,
  ProjectDetail,
  ProjectOverview,
  ProjectRemote,
  ProjectWorktreeInfo
} from '../shared/types.ts'
import {
  dirIconRefs,
  htmlIconRefs,
  ICON_MAX_BYTES,
  iconDataUri,
  manifestIconRefs,
  refPaths
} from './iconCandidates.ts'
import { clearProjectIconOverrides, projectIconOverride } from './projectIconStore.ts'
import { branchAt, detectDefaultBranch, git, localBranches } from './git.ts'
import { isManagedWorktree, parseWorktreeList } from './worktree.ts'

/**
 * Candidate icons, best first.
 *
 * **The project's own icon is the one identity it already has**, and every
 * kind of project keeps it somewhere conventional — an app icon for a desktop
 * build, a favicon for a web app, `app/icon.*` for a Next.js route. Reading it
 * costs one `stat` per miss and beats a folder-name avatar the moment it hits,
 * which is why this list is long and ordered rather than short and clever.
 *
 * The order is *what the thing calls itself*, not what is prettiest: a deliberate
 * app icon outranks a favicon, a favicon outranks a logo, and a logo outranks
 * whatever a framework's starter template left behind (`FRAMEWORK_CANDIDATES`),
 * which sit last because they identify the **framework** and would otherwise
 * give three unrelated projects the same mark.
 *
 * SVG is preferred within each family: it is small enough to survive the byte
 * cap and the only format here that stays sharp at the 28px this is drawn at.
 * `.icns` and `.ico`-only-in-name entries are absent — see `iconDataUri`.
 *
 * **This list is the fast path, not the whole answer.** It is exact paths, so
 * it costs one `stat` each and resolves most repos without opening a single
 * file; a repo that names its icon anything else falls through to the declared
 * and scanned tiers in `readIcon`.
 */
const ICON_CANDIDATES = [
  // A packaged app's own icon: the most deliberate answer a repo can give.
  'build/icon.svg',
  'build/icon.png',
  'resources/icon.svg',
  'resources/icon.png',
  'assets/icon.svg',
  'assets/icon.png',
  // Web app favicons, framework by framework.
  'public/favicon.svg',
  'public/favicon.png',
  'public/icon.svg',
  'public/icon.png',
  'app/icon.svg',
  'app/icon.png',
  'src/app/icon.svg',
  'src/app/icon.png',
  'static/favicon.svg',
  'static/favicon.png',
  'static/icon.svg',
  'static/icon.png',
  'public/apple-touch-icon.png',
  'src/assets/favicon.svg',
  'src/assets/favicon.png',
  'src/assets/logo.svg',
  'src/assets/logo.png',
  'favicon.svg',
  'icon.svg',
  'icon.png',
  'logo.svg',
  'logo.png',
  'public/logo.svg',
  'public/logo.png',
  'docs/logo.svg',
  'docs/logo.png'
] as const

/**
 * The `.ico` files, below what a project *declares* and above what it merely
 * has lying around.
 *
 * **An `.ico` is the weakest format at this size.** It is typically a stack
 * topping out at 32 or 48 pixels — soft at the 44 CSS px, 88 device px, a mark
 * is drawn at — and Chromium picks a frame from it without being asked. A repo
 * that has one almost always has something better beside it: create-react-app
 * ships `public/favicon.ico` *and* `public/logo192.png`, and the `.ico` won
 * purely because it was an exact path while the PNG was only in the manifest.
 *
 * It does **not** drop below the directory scan, though, and the difference
 * matters: a file a project named `favicon.ico` is a decision, while a name
 * that merely starts with `logo` is a guess. Under the scan, every
 * create-next-app repo with a themed logo pair beside it would resolve to
 * `logo-light.svg` — invisible on a light theme, since `classifyInk` only
 * inverts marks that are *dark*.
 */
const ICO_CANDIDATES = [
  'public/favicon.ico',
  'app/favicon.ico',
  'src/app/favicon.ico',
  'static/favicon.ico',
  'favicon.ico'
] as const

/**
 * Starter-template leftovers: a real mark, but the framework's rather than the
 * project's.
 *
 * Last of everything, below even the directory scan — they used to sit at the
 * foot of `ICON_CANDIDATES`, which put them **above** a manifest a project had
 * written on purpose. A repo that both declares its icon and still has
 * `public/vite.svg` lying around is an ordinary repo, and it was showing Vite's
 * mark.
 */
const FRAMEWORK_CANDIDATES = ['public/vite.svg', 'public/next.svg'] as const

/**
 * Files that *declare* an icon, and the directory each one's root-relative
 * paths are served from — see `refPaths`.
 *
 * A manifest before an HTML document because a manifest's `icons[]` is the
 * project's considered answer (sizes, types, purposes) while a `<link>` is
 * usually one line pointing at whatever the generator emitted.
 */
const MANIFEST_CANDIDATES = [
  'public/manifest.json',
  'public/manifest.webmanifest',
  'public/site.webmanifest',
  'static/manifest.json',
  'static/manifest.webmanifest',
  'app/manifest.json',
  'src/app/manifest.json',
  'manifest.json',
  'manifest.webmanifest',
  'site.webmanifest'
] as const

const HTML_CANDIDATES = ['index.html', 'public/index.html', 'src/index.html'] as const

/**
 * Directories an icon is kept in, scanned only when everything above missed.
 *
 * One `readdir` apiece and no recursion — the point is to catch the size and
 * version suffixes nobody standardized (`favicon-v5-64x64.png`), which always
 * sit in exactly these folders. `node_modules` and `dist` are absent on
 * purpose: a build output holds a *copy* of an icon the source already has, and
 * a dependency's icon is not this project's.
 */
const ICON_DIRS = [
  'public',
  'static',
  'app',
  'src/app',
  'assets',
  'src/assets',
  'build',
  'resources',
  ''
] as const

/** The most text worth reading out of a declaration. An `index.html` from a
 * build output can be a megabyte of inlined CSS; its `<head>` is not. */
const DECLARATION_MAX_BYTES = 512 * 1024

interface IconEntry {
  /** The file the URI was built from, and its mtime — absent for a miss. */
  source: { path: string; mtimeMs: number } | null
  uri: string | null
}

/**
 * One resolved icon per project root, for the life of the process.
 *
 * A **hit** re-validates: the source file is `stat`ed and the URI is rebuilt if
 * its mtime moved, so replacing a favicon shows up without a restart. A **miss**
 * does not — there is no file to watch, and re-walking forty candidate paths on
 * every render of a project that has no icon is the cost this cache exists to
 * avoid. Recheck (`clearIconCache`) is the answer for a project that has just
 * been given one, and is why that button says what it says.
 *
 * In memory rather than on disk: the miss costs a handful of `stat`s in a
 * folder the user is looking at, and a disk cache would need an invalidation
 * story this gets for free by not outliving the app.
 */
const icons = new Map<string, IconEntry>()

export function clearIconCache(): void {
  icons.clear()
  clearProjectIconOverrides()
}

/** One candidate read, sniffed and capped, or null. */
async function readIconFile(path: string): Promise<IconEntry | null> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch {
    return null
  }
  if (!info.isFile() || info.size === 0) return null
  // Over the cap: skip this candidate and keep looking. A 1 MB source is the
  // wrong asset for a 28px mark, and the next entry down is usually the right
  // one — Carbon's own repo is exactly this case.
  if (info.size > ICON_MAX_BYTES) return null
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    return null
  }
  const uri = iconDataUri(bytes, path)
  return uri ? { source: { path, mtimeMs: info.mtimeMs }, uri } : null
}

/** The first candidate that is a drawable image. */
async function firstIcon(paths: Iterable<string>): Promise<IconEntry | null> {
  for (const path of paths) {
    const hit = await readIconFile(path)
    if (hit) return hit
  }
  return null
}

/** A declaration's text, or null — bounded, because one of these is an HTML
 * document and some of those are enormous. */
async function readDeclaration(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size === 0) return null
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return null
  return bytes.subarray(0, DECLARATION_MAX_BYTES).toString('utf8')
}

/**
 * The project's own icon as a `data:` URI, or null.
 *
 * Five tiers, and the order between them is **how much the project meant it**:
 * a conventional path it chose, then an icon it declares in a manifest or an
 * `index.html`, then a `favicon.ico`, then anything icon-shaped sitting in the
 * folders icons live in, and only then a framework's leftover. Each tier runs
 * only when the ones above it found nothing, so a repo with
 * `public/favicon.svg` still costs the handful of `stat`s it always did and
 * never opens a directory.
 */
async function readIcon(root: string): Promise<IconEntry> {
  const exact = await firstIcon(ICON_CANDIDATES.map((rel) => join(root, rel)))
  if (exact) return exact

  for (const rel of MANIFEST_CANDIDATES) {
    const text = await readDeclaration(join(root, rel))
    if (!text) continue
    const dir = dirname(rel) === '.' ? '' : dirname(rel)
    const hit = await firstIcon(
      manifestIconRefs(text).flatMap((ref) => refPaths(root, dir, ref))
    )
    if (hit) return hit
  }

  for (const rel of HTML_CANDIDATES) {
    const text = await readDeclaration(join(root, rel))
    if (!text) continue
    const dir = dirname(rel) === '.' ? '' : dirname(rel)
    // An `index.html` at the repo root serves `public/` at `/`, which
    // `refPaths` already tries — so a Vite app's `/favicon.svg` is found
    // whether the file sits beside the HTML or inside `public/`.
    const hit = await firstIcon(
      htmlIconRefs(text).flatMap((ref) => [
        ...refPaths(root, dir, ref),
        ...(ref.startsWith('/') ? refPaths(root, 'public', ref) : [])
      ])
    )
    if (hit) return hit
  }

  const ico = await firstIcon(ICO_CANDIDATES.map((rel) => join(root, rel)))
  if (ico) return ico

  for (const dir of ICON_DIRS) {
    const names = await readdir(join(root, dir)).catch(() => null)
    if (!names) continue
    const hit = await firstIcon(dirIconRefs(names).map((name) => join(root, dir, name)))
    if (hit) return hit
  }

  const leftover = await firstIcon(FRAMEWORK_CANDIDATES.map((rel) => join(root, rel)))
  if (leftover) return leftover

  return { source: null, uri: null }
}

/** A project's mark, and whether the user picked it rather than the scan. */
interface ResolvedIcon {
  uri: string | null
  custom: boolean
}

/**
 * **The override is read first, and above the `exists` gate.** It is not in the
 * project's folder, so a project whose directory was moved or deleted keeps the
 * icon its owner chose — and a user who overrode a scan result must never see
 * the scan's answer again until they say so.
 */
async function projectIcon(root: string, exists: boolean): Promise<ResolvedIcon> {
  const override = await projectIconOverride(root)
  if (override === 'initials') return { uri: null, custom: true }
  if (override) return { uri: override.uri, custom: true }

  const hit = icons.get(root)
  if (hit) {
    // A miss stays a miss until Recheck. A hit is only kept while the file it
    // was read from is still the file it was read from.
    if (!hit.source) return { uri: null, custom: false }
    const fresh = await stat(hit.source.path).catch(() => null)
    if (fresh && fresh.mtimeMs === hit.source.mtimeMs) return { uri: hit.uri, custom: false }
  }
  // A folder that isn't there has no icon to find, and walking forty paths
  // inside it would be forty `stat`s answering nothing. Whatever was resolved
  // while it existed is kept: a missing project still deserves its mark.
  if (!exists) return { uri: hit?.uri ?? null, custom: false }
  const entry = await readIcon(root)
  icons.set(root, entry)
  return { uri: entry.uri, custom: false }
}

/**
 * `origin`, parsed.
 *
 * Every shape git accepts lands on the same three facts — host, owner, repo —
 * and the differences between them are punctuation: scp-style `git@host:path`,
 * a URL with a scheme, or a bare path with no host at all. The last one is a
 * real remote (a clone of a folder, a USB drive) and correctly answers null, so
 * the row prints the raw string instead of inventing an owner.
 *
 * Nested groups are kept whole — GitLab's `group/subgroup/repo` is one owner
 * and one repo, not three — by taking the *last* segment as the repo and
 * everything before it as the owner.
 */
export function parseRemoteUrl(raw: string): ProjectRemote | null {
  const url = raw.trim()
  if (!url) return null

  let host = ''
  let path = ''

  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(url)
  if (scp) {
    // scp-style: `git@github.com:owner/repo.git`. The `(?!\/)` is what keeps
    // `https://…` out — there the colon is followed by a slash.
    host = scp[1] ?? ''
    path = scp[2] ?? ''
  } else {
    const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.*)$/i.exec(url)
    if (!scheme) return null
    host = scheme[1] ?? ''
    path = scheme[2] ?? ''
  }

  const segments = path
    .replace(/\.git$/i, '')
    .split('/')
    .filter((s) => s.length > 0)
  const repo = segments.pop()
  if (!host || !repo || segments.length === 0) return null
  const owner = segments.join('/')

  // A URL is only offered for something that looks like a host on the public
  // internet. An SSH alias from `~/.ssh/config` (`git@github-work:o/r`) has no
  // dot and resolves nowhere in a browser, so it gets the name and no link.
  const url_ = host.includes('.') ? `https://${host}/${owner}/${repo}` : ''
  return { host, owner, repo, url: url_ }
}

/** `git remote get-url origin`, or '' — an unconfigured remote is normal. */
async function originUrl(root: string): Promise<string> {
  return (await git(root, ['remote', 'get-url', 'origin'], 8_000).catch(() => '')).trim()
}

/** Files with uncommitted changes in one tree; null when it can't be read. */
async function dirtyCount(cwd: string): Promise<number | null> {
  const out = await git(cwd, ['status', '--porcelain'], 10_000).catch(() => null)
  if (out === null) return null
  return out.split('\n').filter((l) => l.trim().length > 0).length
}

/** Whether a path is a directory that is still there. */
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Run `work` over `items`, at most `limit` at a time.
 *
 * A bare `Promise.all` over the project list would spawn every git process at
 * once — fifteen projects is fifteen `rev-parse`s, fifteen `remote get-url`s
 * and fifteen `worktree list`s landing together, on the machine that is also
 * running the user's agents. The section is not fast enough to be worth that.
 */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner))
  return out
}

/** How many git processes this module will have in flight at once. */
const CONCURRENCY = 4

async function overview(root: string): Promise<ProjectOverview> {
  const exists = await isDir(root)
  const { uri: icon, custom: customIcon } = await projectIcon(root, exists)
  if (!exists) {
    // Nothing else can be asked of a folder that isn't there, and asking would
    // mean a git process per dead project every time the page opens.
    return {
      root,
      exists: false,
      isRepo: false,
      branch: null,
      remote: null,
      remoteUrl: null,
      icon,
      customIcon,
      worktrees: 0,
      branches: 0
    }
  }

  const [branch, remoteRaw, worktreeOut, branches] = await Promise.all([
    branchAt(root).catch(() => null),
    originUrl(root),
    git(root, ['worktree', 'list', '--porcelain'], 10_000).catch(() => ''),
    localBranches(root).catch(() => [] as BranchRef[])
  ])

  // A detached HEAD is still a repo, so `branch` alone can't answer this;
  // `worktree list` fails outside one, and its first record is the checkout.
  const worktrees = parseWorktreeList(worktreeOut)
  const isRepo = worktreeOut.trim().length > 0 || branch !== null

  return {
    root,
    exists: true,
    isRepo,
    branch,
    remote: parseRemoteUrl(remoteRaw),
    remoteUrl: remoteRaw || null,
    icon,
    customIcon,
    worktrees: Math.max(0, worktrees.filter((w) => !w.isMain).length),
    branches: branches.length
  }
}

/**
 * Just the marks, for the sidebar.
 *
 * The sidebar draws a project's icon on rows that are on screen at first
 * paint, and `projectsOverview` cannot be what answers it: that call spawns
 * two or three git processes *per project* — which is exactly why it belongs
 * to a settings page, opened deliberately, that pays for what it shows. An
 * icon is a walk of `stat`s and one `readFile`, cached for the life of the
 * process, so it is the half of the overview that can sit on the launch path.
 *
 * The same `icons` map answers both, which is what keeps the sidebar's mark
 * and the settings page's the same picture, and what lets Recheck
 * (`clearIconCache`) reach a mark the sidebar is drawing.
 */
export async function projectIcons(roots: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  await pool([...new Set(roots)], CONCURRENCY, async (root) => {
    out[root] = (await projectIcon(root, await isDir(root))).uri
  })
  return out
}

export async function projectsOverview(
  roots: string[],
  refresh = false
): Promise<ProjectOverview[]> {
  if (refresh) clearIconCache()
  const unique = [...new Set(roots)]
  return pool(unique, CONCURRENCY, overview)
}

/**
 * One project's worktrees and branches.
 *
 * `listWorktrees` is deliberately not reused: it *drops* worktrees whose
 * directory is gone, which is right for a picker that would start a chat in one
 * and wrong here — a stale worktree is the same "folder no longer exists" flag
 * one level down, and removing it is the action the card offers. So the list is
 * parsed here, the missing ones are kept and marked, and `merged` is computed
 * the same way `listWorktrees` computes it: one `branch --merged` for the whole
 * list rather than one per worktree.
 */
export async function projectDetail(root: string): Promise<ProjectDetail> {
  const empty: ProjectDetail = { root, worktrees: [], branches: [], defaultBranch: null }
  if (!(await isDir(root))) return empty

  const [listed, branches, defaultBranch] = await Promise.all([
    git(root, ['worktree', 'list', '--porcelain'], 10_000)
      .then(parseWorktreeList)
      .catch(() => []),
    localBranches(root).catch(() => [] as BranchRef[]),
    detectDefaultBranch(root).catch(() => null)
  ])

  const mergedSet = new Set<string>()
  if (defaultBranch) {
    const out = await git(root, [
      'branch',
      '--merged',
      defaultBranch,
      '--format=%(refname:short)'
    ]).catch(() => '')
    for (const line of out.split('\n')) {
      const name = line.trim()
      if (name) mergedSet.add(name)
    }
  }

  const worktrees = await pool(listed, CONCURRENCY, async (w): Promise<ProjectWorktreeInfo> => {
    // git's own `prunable` is authoritative when it is set, but it is only
    // recomputed on some commands — a `stat` is the answer that is always
    // current, and the two agree everywhere it matters.
    const missing = w.prunable === true || !(await isDir(w.path))
    return {
      path: w.path,
      branch: w.branch,
      isMain: w.isMain,
      managed: isManagedWorktree(w.path),
      // The main checkout is never "finished", so it is never marked merged —
      // the same rule `listWorktrees` applies.
      ...(defaultBranch && !w.isMain ? { merged: mergedSet.has(w.branch) } : {}),
      missing,
      dirtyFiles: missing ? null : await dirtyCount(w.path)
    }
  })

  return { root, worktrees, branches, defaultBranch }
}
