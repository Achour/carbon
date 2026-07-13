import { join } from 'node:path'

/**
 * Pure image-discovery logic for a Codex turn, split out from `CodexSession` so
 * it can be unit-tested without a live SDK thread or the filesystem.
 *
 * Codex's image-gen skill saves the picture to a file and only *sometimes* reports
 * its path as a markdown link (effort-dependent), so keying off the final message
 * misses images. `pickTurnImages` instead scans everything the turn produced —
 * prose, shell commands, structured file changes — for image files it wrote this
 * turn, and returns the ones to render inline.
 */

export const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif)$/i

/** Commands that produce a file at their last path argument. */
export const COPY_COMMANDS = new Set([
  'cp',
  'mv',
  'install',
  'rsync',
  'ln',
  'convert',
  'magick',
  'cwebp',
  'sips',
  'ffmpeg'
])

/**
 * Split a shell command into tokens, honoring single/double quotes and
 * backslash-escaped spaces, so a path argument like `"my logo.png"` or
 * `my\ logo.png` comes back as one token instead of being torn on whitespace.
 * Not a full shell parser — just enough to recover file arguments.
 */
export function shellTokens(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      has = true
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i]
      has = true
    } else if (/\s/.test(c)) {
      if (has) {
        out.push(cur)
        cur = ''
        has = false
      }
    } else {
      cur += c
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}

/** What the caller learned about a path by stat()ing it (null = not a readable file). */
export type ImageStat = { isFile: boolean; mtimeMs: number; real: string }

export interface PickTurnImagesInput {
  /** Concatenated assistant text of the turn. */
  text: string
  /** Every shell command run this turn (command strings and their outputs). */
  commands: string[]
  /** Paths from structured `file_change` items — trusted writes (no mtime check). */
  changes: string[]
  /** Fresh files discovered directly in this Codex thread's generated-images dir. */
  generated: string[]
}

export interface PickTurnImagesDeps {
  cwd: string
  /** Home directory, for expanding `~/`. */
  home: string
  /** `$CODEX_HOME/generated_images` — raw sources live here; project copies win. */
  genDir: string
  /** Turn start (ms); untrusted matches older than this - 2s are treated as reads. */
  turnStart: number
  /** stat + realpath a path, or null if it isn't a readable file. */
  stat: (abs: string) => ImageStat | null
}

/**
 * Resolve a raw path token to an absolute path: strip surrounding quotes,
 * unescape `\ `, percent-decode (`%20`), expand `~`, and root relatives at cwd.
 */
function toAbs(raw: string, cwd: string, home: string): string {
  let p = raw.trim()
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1)
  }
  p = p.replace(/\\ /g, ' ')
  try {
    p = decodeURI(p)
  } catch {
    // leave the raw path if it isn't valid percent-encoding
  }
  return p.startsWith('/')
    ? p
    : p.startsWith('~/')
      ? join(home, p.slice(2))
      : join(cwd, p.replace(/^\.\//, ''))
}

/**
 * Return the real paths of images to surface inline for a turn (≤4), preferring a
 * project deliverable over the raw generated source and skipping anything the
 * agent already rendered as a markdown image. See `CodexSession.surfaceTurnImages`.
 */
export function pickTurnImages(input: PickTurnImagesInput, deps: PickTurnImagesDeps): string[] {
  const { text, commands, changes, generated } = input
  const { cwd, home, genDir, turnStart, stat } = deps

  // `trusted` = definitely written this turn (a structured file_change, or a
  // copy/move destination) so its mtime isn't checked — `cp -p` preserves the
  // source's older mtime, which would otherwise reject the real deliverable. The
  // rest are prose matches, mtime-gated so a merely *read* image isn't surfaced.
  const candidates: { path: string; trusted: boolean }[] = []
  for (const c of changes) {
    if (IMAGE_EXT.test(c)) candidates.push({ path: c, trusted: true })
  }
  // The Codex SDK currently omits built-in image_gen calls from its ThreadItem
  // union. A successful generation can therefore end with no path in assistant
  // text, command output, or file_change events. CodexSession snapshots the
  // thread-specific generated-images directory and supplies newly created or
  // overwritten files here. Keep the mtime check as a second guard against an
  // old image being surfaced if a caller's snapshot is incomplete.
  for (const c of generated) {
    if (IMAGE_EXT.test(c)) candidates.push({ path: c, trusted: false })
  }

  // Markdown destinations the agent already rendered inline (the Markdown
  // component resolves `[x](path)` / `![x](path)` itself) — don't surface those
  // again. Handles `<a b.png>` bracketed forms and `%20`-encoded spaces.
  const linkedRaw: string[] = []
  for (const m of text.matchAll(/\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    let dest = m[1]
    if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1)
    if (IMAGE_EXT.test(dest)) linkedRaw.push(dest)
  }

  // project(0) is preferred over a raw generated file(1); lower rank = better.
  const rank = (real: string): number => (real.startsWith(genDir) ? 1 : 0)

  // Quote-aware tokens from every command. For a copy/move/convert command the
  // last image arg is the produced destination (trusted); the earlier image args
  // are its *inputs*. An input's content lives on in the destination, so suppress
  // it — by REAL path, so it's dropped even when it was also a trusted structured
  // `file_change` (a produced intermediate that then gets copied to the final
  // output). Chained ops (a→b, b→final) thus suppress every non-terminal file.
  // Guard: only suppress when the destination is at least as preferred as the
  // input (project ≤ raw), so copying a project deliverable *to* a raw backup
  // doesn't wrongly drop the deliverable.
  const suppressReal = new Set<string>()
  for (const cmd of commands) {
    const toks = shellTokens(cmd)
    const imgToks = toks.filter((t) => IMAGE_EXT.test(t))
    if (!imgToks.length) continue
    const writer = toks.some((t) => COPY_COMMANDS.has(t.split('/').pop() || ''))
    if (writer && imgToks.length > 1) {
      const dstRaw = imgToks[imgToks.length - 1]
      candidates.push({ path: dstRaw, trusted: true })
      const dst = stat(toAbs(dstRaw, cwd, home))
      if (dst?.isFile) {
        for (let i = 0; i < imgToks.length - 1; i++) {
          const src = stat(toAbs(imgToks[i], cwd, home))
          if (src?.isFile && rank(dst.real) <= rank(src.real)) suppressReal.add(src.real)
        }
      }
    } else {
      for (const t of imgToks) candidates.push({ path: t, trusted: writer })
    }
  }
  // Bare (unquoted) image tokens in prose the agent didn't format as a link.
  for (const m of text.matchAll(/(?:~\/|\.{0,2}\/)?[\w.@/+-]+\.(?:png|jpe?g|webp|gif)/gi)) {
    candidates.push({ path: m[0], trusted: false })
  }
  if (!candidates.length) return []

  // Normalize linked destinations to real paths so a candidate that resolves to
  // the same file as an already-shown markdown image is skipped.
  const linkedReal = new Set<string>()
  for (const l of linkedRaw) {
    const st = stat(toAbs(l, cwd, home))
    if (st?.isFile) linkedReal.add(st.real)
  }
  const seen = new Set<string>()
  const project: string[] = []
  const raws: string[] = []
  for (const { path: p, trusted } of candidates) {
    const st = stat(toAbs(p, cwd, home))
    if (!st || !st.isFile) continue
    // A copy input never surfaces (its content is in the destination), even if it
    // was a trusted structured write.
    if (suppressReal.has(st.real)) continue
    // Untrusted (prose/non-writer) matches must be fresh this turn — an image the
    // agent merely *read* isn't surfaced; trusted destinations always show.
    if (!trusted && st.mtimeMs < turnStart - 2000) continue
    if (linkedReal.has(st.real) || seen.has(st.real)) continue // already shown / duped
    seen.add(st.real)
    ;(st.real.startsWith(genDir) ? raws : project).push(st.real)
  }
  // Prefer the deliverable saved into the project over the raw generated source.
  return (project.length ? project : raws).slice(0, 4)
}
