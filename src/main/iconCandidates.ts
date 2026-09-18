/**
 * Where a project's icon is *declared*, and what is lying next to it.
 *
 * `ICON_CANDIDATES` in `projects.ts` is a list of exact paths, which answers
 * for every project that names its icon the way its framework's template did.
 * It answers for nothing else: a repo carrying `public/favicon-v5-64x64.png`,
 * `public/favicon-32x32.png` and a `manifest.json` that names both has a mark
 * on disk, declares it twice, and still fell back to two grey letters — which
 * is the bug this module fixes.
 *
 * Three sources, and the order between them is *how much the project meant
 * it*:
 *
 *   1. **A web app manifest** — `icons[]` is the project stating, in a file
 *      whose only job is to state it, which image represents it.
 *   2. **`<link rel="icon">` in an `index.html`** — the same statement for the
 *      whole Vite/plain-web class, which ships no manifest.
 *   3. **Whatever is named like an icon** in the directories icons live in.
 *      A guess, so it sits last, and it is the tier that catches the version
 *      and size suffixes nobody standardized.
 *
 * All three land on one ranking, because all three answer the same question
 * and a project that declares one thing and stores another should resolve the
 * same way whichever tier found it. Pure and `node:*`-only, so `node --test`
 * can pin the ranking without a bundler or an Electron.
 */

import { Buffer } from 'node:buffer'
import { basename, extname, join } from 'node:path'
import { imageMime, parseIconLinks } from './faviconCache.ts'

/** Extensions this can rank. Anything else is not an icon candidate. */
const IMAGE_EXT = /\.(svg|png|ico|webp|avif|gif|jpe?g|bmp)$/i

/**
 * The ceiling on an icon.
 *
 * It is a *transport* limit before it is a taste one: every hit is base64'd
 * into a `data:` URI and shipped across IPC with the rest of the list, so a
 * 1 MB source is a 1.4 MB string times however many projects the user has.
 * Carbon's own `build/icon-1024.png` is 979 KB and is correctly skipped in
 * favour of the 1.7 KB `build/icon.svg` beside it — which is also the better
 * mark at 28px, so the cap and the ranking agree.
 */
export const ICON_MAX_BYTES = 128 * 1024

/** Extensions mapped to the type `imageMime` cannot sniff (SVG is markup). */
const EXT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
}

/**
 * Formats Chromium will actually draw in an `<img>`.
 *
 * `imageMime` is shared with the favicon fetcher, which answers for two types
 * this renderer has no use for: HEIC draws nothing at all in Chromium, and an
 * `.icns` never reaches here because no candidate names one. Refusing them by
 * name keeps a silent blank square from being the answer — a project with no
 * icon should fall back to its initials, which is a mark.
 */
const DRAWABLE = new Set([
  'image/svg+xml',
  'image/png',
  'image/x-icon',
  'image/webp',
  'image/gif',
  'image/jpeg',
  'image/bmp',
  'image/avif'
])

/**
 * Bytes as a `data:` URI, or null if they are not a drawable image.
 *
 * The file is *sniffed*, not trusted: `public/favicon.ico` is very often a PNG
 * (or, in a framework starter, an HTML 404 that got committed), and a `data:`
 * URI carrying markup draws nothing while looking exactly like a broken icon.
 * `imageMime` is the favicon fetcher's own gate, reused whole — it refuses
 * markup that isn't an SVG whatever the extension claims.
 */
export function iconDataUri(bytes: Buffer, path: string): string | null {
  const mime = imageMime(bytes, EXT_TYPES[extname(path).toLowerCase()] ?? null)
  if (!mime || !DRAWABLE.has(mime)) return null
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/**
 * What a file is called, once a URL's tail is off it.
 *
 * A declared href is a *URL*, so `favicon.ico?v=4` and `icon.png#mark` are
 * both ordinary — and both name a file that exists without the tail.
 */
function refName(ref: string): string {
  return basename(ref.split(/[?#]/)[0] ?? '')
}

/**
 * How well a format survives being drawn at 44px on a retina panel.
 *
 * SVG and PNG are the two anyone ships deliberately. `.ico` is usually a 32px
 * raster and frequently several stacked, which Chromium picks from without
 * being told which — it draws, but it is nobody's best asset. The photographic
 * formats are last because an icon in one is almost always a screenshot or a
 * banner that happens to be called `logo.jpg`.
 */
function formatRank(name: string, type: string): number {
  if (type === 'image/svg+xml' || /\.svg$/i.test(name)) return 0
  if (/\.(png|webp|avif)$/i.test(name)) return 0
  if (/\.(ico|gif)$/i.test(name)) return 1
  return 2
}

/** Every `NxN` in a string, as the largest edge it claims. */
function declaredPx(text: string): number {
  let best = 0
  for (const m of text.matchAll(/(\d+)\s*[x×]\s*(\d+)/g)) {
    best = Math.max(best, Number(m[1]), Number(m[2]))
  }
  return best
}

/**
 * How close a candidate is to the size this is drawn at — **128px, not 32px**.
 *
 * `faviconCache`'s own ranking wants 32, because a favicon beside a link is
 * 16 CSS px and a 512px source there is a quarter-megabyte for nothing. A
 * project's mark is a different picture: `ProjectAvatar` draws it at up to
 * 44 CSS px, which is 88 device px on the panel this is developed on, so the
 * 32px `.ico` that is perfect for a link is visibly soft here.
 *
 * So anything at or above 96px is *good*, ranked by bytes rather than pixels —
 * a 192px PNG beats the 512px one beside it, being 13 KB against 66 KB and
 * indistinguishable at this size. Below 96 the usual rule applies and bigger
 * wins. An undeclared size sits between the two: `apple-touch-icon.png` names
 * no size and is 180px in practice, and refusing to rank it would drop the one
 * asset a lot of sites have at a usable size.
 */
function sizeScore(px: number, scalable: boolean): number {
  if (scalable) return 0
  if (px >= 96) return 10 + px / 1000
  if (px > 0) return 100 - px
  return 60
}

interface Candidate {
  /** The path or URL the source declared, verbatim. */
  ref: string
  sizes: string
  type: string
  /** Down-ranked without being dropped — see `manifestIconRefs`. */
  demoted: boolean
}

function score(c: Candidate, i: number): number {
  const name = refName(c.ref)
  const scalable =
    c.sizes.includes('any') || c.type === 'image/svg+xml' || /\.svg$/i.test(name)
  const px = declaredPx(c.sizes) || declaredPx(name)
  return (
    (c.demoted ? 1e6 : 0) + formatRank(name, c.type) * 1000 + sizeScore(px, scalable) + i / 1e6
  )
}

/** Candidates best first, deduplicated, ties keeping the order they came in. */
function rank(cands: Candidate[]): string[] {
  const out: string[] = []
  for (const c of cands
    .map((c, i) => ({ c, score: score(c, i) }))
    .sort((a, b) => a.score - b.score)) {
    if (!out.includes(c.c.ref)) out.push(c.c.ref)
  }
  return out
}

/**
 * The icons a web app manifest declares, best first.
 *
 * **A `maskable` icon is drawn to be cropped.** Android trims it to a circle or
 * a squircle, so the art sits inside a safe zone with up to 20% padding on each
 * edge — rendered whole, as this does, it is a small mark floating in a lot of
 * space. It is still the project's own icon, so it is kept and ranked below
 * everything else rather than dropped, for the manifests that declare nothing
 * but maskable ones. An entry with both purposes is not demoted: it is being
 * offered for unmasked use too.
 *
 * Nothing here throws on a malformed file — a manifest that is a JSON parse
 * error, or declares `icons` as a string, contributes no candidates and the
 * next tier answers.
 */
export function manifestIconRefs(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const icons = (parsed as { icons?: unknown } | null)?.icons
  if (!Array.isArray(icons)) return []
  const cands: Candidate[] = []
  for (const entry of icons) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const src = typeof row.src === 'string' ? row.src.trim() : ''
    if (!src) continue
    const purpose = typeof row.purpose === 'string' ? row.purpose.toLowerCase().split(/\s+/) : []
    cands.push({
      ref: src,
      sizes: typeof row.sizes === 'string' ? row.sizes.toLowerCase() : '',
      type: typeof row.type === 'string' ? row.type.toLowerCase() : '',
      demoted: purpose.includes('maskable') && !purpose.includes('any')
    })
  }
  return rank(cands)
}

/**
 * The icons an HTML document declares, best first.
 *
 * `parseIconLinks` is the favicon fetcher's own parser, reused whole: it reads
 * only the `<head>`, drops Safari's monochrome `mask-icon`, and decodes the
 * entities an href can carry. Only the *ranking* differs, for the reason
 * `sizeScore` gives.
 */
export function htmlIconRefs(html: string): string[] {
  return rank(
    parseIconLinks(html).map((link) => ({
      ref: link.href,
      sizes: link.sizes,
      type: link.type,
      demoted: false
    }))
  )
}

/**
 * Names that are worth `stat`ing, out of a directory listing.
 *
 * Anchored at the start, so `favicon-v5-64x64.png` and `apple-touch-icon.png`
 * are candidates and `og-image.png` is not. `icons.json` and `logo.tsx` are
 * excluded by the extension, which is the only part of this that has to be
 * exact — a false positive here is a broken-looking mark on a project that had
 * a perfectly good fallback.
 */
const ICON_NAME = /^(favicon|icon|app-?icon|apple-touch-icon|logo)\b/i

/** Icon-shaped files in one directory listing, best first. */
export function dirIconRefs(names: string[]): string[] {
  return rank(
    names
      .filter((n) => IMAGE_EXT.test(n) && ICON_NAME.test(n))
      .map((n) => ({ ref: n, sizes: '', type: '', demoted: false }))
  )
}

/**
 * A declared ref as the repo-relative paths worth trying, best first.
 *
 * **A root-relative href names a *served* path, and the repo is not the
 * server.** `/favicon-v5.ico` in `public/manifest.json` is `public/favicon-v5.ico`
 * on disk, because every one of these frameworks serves `public/` (or `static/`)
 * at the site root — but a project that serves its repo root directly means the
 * file beside the manifest. Both are tried, nearest first, since a path that
 * isn't there costs one `stat`.
 *
 * Absolute URLs and `data:` are dropped: the first is a CDN this would have to
 * go to the network for, and the second is already an icon nobody needs a file
 * for. `%PUBLIC_URL%` is create-react-app's placeholder for exactly the site
 * root this is resolving, so it comes off.
 */
export function refPaths(root: string, dir: string, ref: string): string[] {
  const clean = ref.split(/[?#]/)[0]?.replace(/^%PUBLIC_URL%/, '') ?? ''
  if (!clean || /^(data:|https?:|\/\/)/i.test(clean)) return []
  if (clean.includes('..') || clean.includes('\0')) return []
  if (!clean.startsWith('/')) return [join(root, dir, clean)]
  const served = clean.slice(1)
  if (!served) return []
  const here = join(root, dir, served)
  const there = join(root, served)
  return here === there ? [here] : [here, there]
}
