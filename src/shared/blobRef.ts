/**
 * The name an image goes by once it lives in main's blob store
 * (`main/blobStore.ts`): the SHA-256 of its bytes and an extension for its type,
 * e.g. `3f…a9.png`. Content-addressed, so the same screenshot sent twice is
 * stored once, and a name can never be pointed at different bytes.
 *
 * Shared because three places spell it: main (which writes and serves the
 * files), the desktop renderer (which draws one through `BLOB_SCHEME`) and the
 * phone client (which draws one through `/api/blob/`). Dependency-free, so
 * `node --test` can run it as-is.
 */

/** The custom protocol the desktop renderer loads a stored image through. */
export const BLOB_SCHEME = 'carbon-blob'

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/heic': 'heic'
}

const TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  heic: 'image/heic',
  bin: 'application/octet-stream'
}

const REF = /^([0-9a-f]{64})\.([a-z0-9]{2,5})$/

export function blobRef(sha256Hex: string, mediaType: string): string {
  return `${sha256Hex}.${EXT_BY_TYPE[mediaType.toLowerCase()] ?? 'bin'}`
}

/** A well-formed ref, and nothing a path could be built from otherwise. */
export function isBlobRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF.test(ref) && ref.slice(65) in TYPE_BY_EXT
}

/** The Content-Type a ref is served with, read off its extension. */
export function blobMediaType(ref: string): string {
  return TYPE_BY_EXT[ref.slice(ref.lastIndexOf('.') + 1)] ?? 'application/octet-stream'
}
