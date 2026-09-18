/**
 * Choosing the file that becomes a project's mark.
 *
 * The electron half of `projectIconStore.ts`: a file dialog and an image
 * resizer, which is everything about an override that cannot run under plain
 * `node --test`. The store itself stays `node:*`-only because the *scan*
 * imports it — see the note at the head of that file.
 */

import { Buffer } from 'node:buffer'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { dialog, nativeImage, type BrowserWindow } from 'electron'
import { ICON_MAX_BYTES, iconDataUri } from './iconCandidates.ts'
import { saveProjectIcon } from './projectIconStore.ts'

/** Anything bigger than this is not a mishandled icon, it is the wrong file. */
const SOURCE_MAX_BYTES = 32 * 1024 * 1024

/**
 * A chosen file, normalized into something a 44px avatar can draw.
 *
 * SVG passes through — it is already the right asset and re-encoding it would
 * throw away the one format that stays sharp. A raster is re-encoded **only
 * when it has to be**: over the transport cap, or wider than 512px, which is
 * the common case of someone picking their 2048px brand PNG. A 3 KB 64px
 * favicon is left exactly as it is rather than upscaled into a blurry 256px
 * one, which is what normalizing everything would do.
 *
 * Returns the bytes to store, or the sentence to show.
 */
function normalize(bytes: Buffer, source: string): { ext: string; bytes: Buffer } | string {
  const ext = extname(source).toLowerCase()
  if (!iconDataUri(bytes, source)) {
    return 'That file is not an image Carbon can draw. Pick a PNG, SVG, WebP or ICO.'
  }
  if (ext === '.svg') {
    return bytes.length > ICON_MAX_BYTES
      ? `That SVG is ${Math.round(bytes.length / 1024)} KB — too big to draw as an icon.`
      : { ext, bytes }
  }
  const img = nativeImage.createFromBuffer(bytes)
  if (!img.isEmpty() && (bytes.length > ICON_MAX_BYTES || img.getSize().width > 512)) {
    const png = img.resize({ width: 256, quality: 'best' }).toPNG()
    if (png.length && png.length <= ICON_MAX_BYTES) return { ext: '.png', bytes: png }
  }
  // Chromium could not decode it (an `.ico` reaches here on macOS) — keep the
  // original if it is small enough to ship, and say so plainly if it is not.
  if (bytes.length > ICON_MAX_BYTES) {
    return `That image is ${Math.round(bytes.length / 1024)} KB and could not be resized. Pick a smaller one.`
  }
  return { ext: ext || '.png', bytes }
}

/**
 * Point a project at an image file.
 *
 * `source` absent opens the picker — which is how the UI calls it, and passing
 * a path is what makes the whole thing drivable from `AIGUI_E2E` without a
 * human clicking through a native dialog.
 *
 * Answers the resolved `data:` URI, or an error string the settings pane shows
 * verbatim — empty for a cancelled dialog, which is not a failure to report.
 * Never throws: every other way this fails is something about the file that was
 * picked, and that deserves a sentence rather than a silent nothing.
 */
export async function setProjectIcon(
  win: BrowserWindow | null,
  root: string,
  source?: string
): Promise<{ icon: string } | { error: string }> {
  let path = source
  if (!path) {
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose a project icon',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'svg', 'webp', 'ico', 'jpg', 'jpeg', 'gif'] }]
    }
    // Sheeted to the window when there is one, so it cannot be lost behind it.
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths[0]) return { error: '' }
    path = result.filePaths[0]
  }
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return { error: 'That file is not there any more.' }
  if (info.size > SOURCE_MAX_BYTES) return { error: 'That file is far too large to be an icon.' }
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return { error: 'That file could not be read.' }
  const normalized = normalize(bytes, path)
  if (typeof normalized === 'string') return { error: normalized }
  const uri = iconDataUri(normalized.bytes, `icon${normalized.ext}`)
  if (!uri) return { error: 'That image could not be converted into an icon.' }
  await saveProjectIcon(root, normalized.ext, normalized.bytes)
  return { icon: uri }
}
