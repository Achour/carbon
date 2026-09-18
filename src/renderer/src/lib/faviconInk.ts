/**
 * Which favicons are a dark monochrome glyph on transparency.
 *
 * **A favicon is drawn for the site's own background, not for ours.** GitHub's
 * `/favicon.ico` is a black Octocat on a transparent field — correct on their
 * white page, and on Carbon's dark one an invisible mark leaving a gap where a
 * mark should be. It is not a rare shape either: a single-colour glyph on
 * transparency is the house style for developer sites, which is most of what an
 * agent cites and most of what anyone points a preview pane at.
 *
 * So the mark is *measured* rather than trusted, once per key, and inverted
 * only in dark mode and only when all three hold: it is essentially unsaturated
 * (inverting a colour would be vandalism), it is dark on average, and it has
 * real transparency. That last one is what keeps a filled black tile — a logo
 * whose square *is* the design — from being turned into a white one; it stays
 * as drawn, which is the site's own answer even if it reads quietly here.
 *
 * The alternative was to prefer the `<link rel="icon">` the page declares,
 * which for GitHub is an SVG that answers `prefers-color-scheme`. It costs an
 * HTML fetch per origin — `main/faviconCache.ts` asks for `/favicon.ico` first
 * precisely so most sites cost one request — and it only helps sites that
 * bothered to publish a dark variant. Measuring what we already hold costs one
 * 16×16 decode and covers every site. (The browser pane gets the declared
 * variant for free, since its guest resolves the media query itself — and still
 * measures, because most sites publish only the one icon.)
 *
 * **The key is the caller's, not the URI's.** A link keys on the origin, so
 * eight citations of one site share a verdict; the browser pane keys on the
 * icon's own URL, because one origin can hand out a different mark per page.
 * Keying on the `data:` URI itself would work and would put a quarter-megabyte
 * string in a Map.
 */

const verdicts = new Map<string, boolean>()

/**
 * Measurements in flight, so N rows sharing a key decode once.
 *
 * `verdicts` only answers *after* the decode resolves, which was fine while
 * every caller was a single row on a settings page. The sidebar draws forty
 * chat rows over a handful of projects and its marks all arrive in the same
 * tick, so without this one project's icon is decoded once per row it appears
 * on — forty `Image` loads and forty canvases for one 16x16 answer.
 */
const inflight = new Map<string, Promise<boolean>>()

/** The verdict for a key, or false while it is unknown — a mark drawn as the
 * site drew it is the safe answer, and the wrong one is invisible. */
export function inkDark(key: string | null | undefined): boolean {
  return !!key && verdicts.get(key) === true
}

/** Whether a key has been measured — the caller re-renders on the verdict, and
 * a settled one must not schedule a second render that changes nothing. */
export function inkKnown(key: string): boolean {
  return verdicts.has(key)
}

/** Whether a mark needs inverting on a dark ground. Measured once per key. */
export function classifyInk(key: string, uri: string): Promise<boolean> {
  const known = verdicts.get(key)
  if (known !== undefined) return Promise.resolve(known)
  const running = inflight.get(key)
  if (running) return running
  const measured = new Promise<boolean>((resolve) => {
    const done = (dark: boolean): void => {
      verdicts.set(key, dark)
      inflight.delete(key)
      resolve(dark)
    }
    const img = new Image()
    img.onload = () => {
      try {
        const n = 16
        const canvas = document.createElement('canvas')
        canvas.width = n
        canvas.height = n
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return done(false)
        ctx.drawImage(img, 0, 0, n, n)
        // A `data:` URI is same-origin, so this never taints the canvas — which
        // is the whole reason both callers resolve their icon to one first.
        const { data } = ctx.getImageData(0, 0, n, n)
        let visible = 0
        let clear = 0
        let luma = 0
        let saturation = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 32) {
            clear++
            continue
          }
          visible++
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]
          luma += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
          const max = Math.max(r, g, b)
          const min = Math.min(r, g, b)
          // **Mean, not max.** The peak saturation of a black glyph is not
          // zero: antialiasing along a curve leaves a handful of faintly
          // coloured pixels, and GitHub's Octocat measures 0.21 that way — so
          // a max-based test called the blackest icon on the web "coloured"
          // and left it invisible. Averaged over what is actually drawn, the
          // same mark is ~0.01 and a genuinely coloured one stays far above.
          saturation += max === 0 ? 0 : (max - min) / max
        }
        done(
          visible > 0 &&
            clear / (n * n) > 0.15 &&
            saturation / visible < 0.12 &&
            luma / visible < 0.35
        )
      } catch {
        done(false)
      }
    }
    img.onerror = () => done(false)
    img.src = uri
  })
  inflight.set(key, measured)
  return measured
}
