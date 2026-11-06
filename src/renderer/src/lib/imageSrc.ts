import { BLOB_SCHEME } from '@shared/blobRef'
import type { StoredImage } from '@shared/types'

/**
 * Where a stored image (`StoredImage.ref`) is fetched from. The desktop loads it
 * through main's `carbon-blob:` protocol; the phone client, which shares these
 * components, points this at its server's `/api/blob/` once at startup.
 */
let base = `${BLOB_SCHEME}://img/`

export function setBlobBase(next: string): void {
  base = next
}

/**
 * The `src` for an image a message or a composer holds: its inline base64 if it
 * still has it (a composer's pick, before it is sent), otherwise its ref.
 */
export function imageSrc(img: Partial<StoredImage>): string {
  if (img.data) return `data:${img.mediaType ?? 'image/png'};base64,${img.data}`
  return img.ref ? base + encodeURIComponent(img.ref) : ''
}

/** Whether there is a picture to draw at all. */
export function hasImage(img: Partial<StoredImage>): boolean {
  return !!(img.data || img.ref)
}
