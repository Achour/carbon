/**
 * Deciding whether a published GitHub release is newer than the running build.
 *
 * Deliberately dependency-free (not even `node:*`) so `node --test` can run the
 * `.ts` directly: this is the only part of the update path with real edge cases
 * — prerelease ordering, a `v` prefix, asset names that differ per arch — and
 * the only part worth pinning with tests. The I/O around it lives in
 * `updates.ts`, which owns the fetch and Electron's `app.getVersion()`.
 */

/** The subset of GitHub's release JSON we read. */
export interface ReleaseJson {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string
  assets?: { name?: string; browser_download_url?: string }[]
}

export interface UpdateCandidate {
  version: string
  downloadUrl: string | null
  releaseUrl: string
  notes: string
  publishedAt: string
}

/** Strip a leading `v` and any build metadata; `v1.2.3+ci.4` → `1.2.3`. */
function normalize(version: string): string {
  return version.trim().replace(/^v/i, '').split('+')[0] ?? ''
}

/**
 * Semver ordering, returning <0 / 0 / >0. Handles the two shapes we actually
 * publish — `1.2.3` and `1.2.3-beta.1` — and treats a prerelease as *older*
 * than the release it leads to, so someone on `0.2.0-beta.1` is offered `0.2.0`.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA = '', preA = ''] = normalize(a).split('-', 2)
  const [coreB = '', preB = ''] = normalize(b).split('-', 2)

  const partsA = coreA.split('.')
  const partsB = coreB.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const na = Number(partsA[i] ?? 0)
    const nb = Number(partsB[i] ?? 0)
    // A non-numeric segment can't be ordered; treat it as 0 rather than NaN,
    // which would make every comparison false and silently suppress updates.
    const va = Number.isFinite(na) ? na : 0
    const vb = Number.isFinite(nb) ? nb : 0
    if (va !== vb) return va - vb
  }

  if (preA === preB) return 0
  // Exactly one is a prerelease → the plain release wins.
  if (!preA) return 1
  if (!preB) return -1

  const idsA = preA.split('.')
  const idsB = preB.split('.')
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const ia = idsA[i]
    const ib = idsB[i]
    if (ia === ib) continue
    if (ia === undefined) return -1
    if (ib === undefined) return 1
    const na = Number(ia)
    const nb = Number(ib)
    const numeric = Number.isFinite(na) && Number.isFinite(nb)
    if (numeric) return na - nb
    return ia < ib ? -1 : 1
  }
  return 0
}

export function isNewerVersion(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0
}

/**
 * The installer a given machine should download.
 *
 * electron-builder names macOS artifacts `Carbon-0.2.0-arm64.dmg` for Apple
 * Silicon and `Carbon-0.2.0.dmg` for Intel — the x64 build carries no arch tag
 * at all, so "no arch in the name" *is* the x64 signal and an arm64 Mac must
 * never fall back to it (a Rosetta build would install over a native one).
 */
export function pickAsset(
  assets: { name?: string; browser_download_url?: string }[],
  platform: string,
  arch: string
): string | null {
  const usable = assets.filter(
    (a): a is { name: string; browser_download_url: string } =>
      typeof a.name === 'string' && typeof a.browser_download_url === 'string'
  )
  // `.blockmap` files sit beside the installers and share their extension prefix.
  const candidates = usable.filter((a) => !a.name.endsWith('.blockmap'))

  // Explicit rather than an if/else chain ending in a default: a platform we
  // don't publish for should get *nothing*, not the Linux build by accident.
  const ext = { darwin: '.dmg', win32: '.exe', linux: '.AppImage' }[platform]
  if (!ext) return null
  const forPlatform = candidates.filter((a) => a.name.endsWith(ext))
  if (forPlatform.length === 0) return null

  const tagged = forPlatform.find((a) => a.name.toLowerCase().includes(arch.toLowerCase()))
  if (tagged) return tagged.browser_download_url

  if (arch === 'arm64') return null
  // x64: prefer the untagged name, but only reject one that is tagged for a
  // *different* arch — `-x64` in the name is still a match for us.
  const untagged = forPlatform.find((a) => !/-(arm64|aarch64)\b/i.test(a.name))
  return untagged?.browser_download_url ?? null
}

/**
 * A release worth telling the user about, or null. Drafts and prereleases are
 * skipped: the update banner is the stable channel.
 */
export function updateFromRelease(
  release: ReleaseJson,
  currentVersion: string,
  platform: string,
  arch: string
): UpdateCandidate | null {
  if (release.draft || release.prerelease) return null
  const tag = release.tag_name ?? release.name ?? ''
  const version = normalize(tag)
  if (!version || !isNewerVersion(currentVersion, version)) return null

  return {
    version,
    downloadUrl: pickAsset(release.assets ?? [], platform, arch),
    releaseUrl: release.html_url ?? '',
    notes: (release.body ?? '').trim(),
    publishedAt: release.published_at ?? ''
  }
}
