import { inflateRawSync } from 'node:zlib'

export interface Zip {
  names: string[]
  /** One entry, inflated on demand; `undefined` if absent, unsupported or over `maxBytes`. */
  read(name: string): Buffer | undefined
}

/**
 * The few files wanted out of a `.vsix` (a zip), read without a dependency.
 *
 * Only the directory is parsed up front; an entry is inflated when it is
 * asked for. A vsix can carry thousands of `.json` files (a bundled
 * `node_modules`), and this runs on the main thread — inflating all of them to
 * read three would stall every window.
 *
 * Sizes and offsets come from the **central directory**, never the local
 * headers: packagers routinely set the data-descriptor flag (bit 3) and write
 * zeros into the local sizes, so a reader that trusts them reads nothing. The
 * declared size is the archive's own claim, so inflation is capped by
 * `maxBytes` rather than by it. Only stored (0) and deflated (8) entries are
 * supported — what every vsix uses.
 */
export function openZip(zip: Buffer, maxBytes = 8 * 1024 * 1024): Zip {
  const eocd = findEndOfCentralDirectory(zip)
  if (eocd < 0) throw new Error('Not a zip archive')
  const count = zip.readUInt16LE(eocd + 10)
  let at = zip.readUInt32LE(eocd + 16)
  const entries = new Map<string, { method: number; compressed: number; size: number; local: number }>()
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('Corrupt zip directory')
    const nameLength = zip.readUInt16LE(at + 28)
    entries.set(zip.toString('utf8', at + 46, at + 46 + nameLength), {
      method: zip.readUInt16LE(at + 10),
      compressed: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      local: zip.readUInt32LE(at + 42)
    })
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const entry = entries.get(name)
      if (!entry || entry.size > maxBytes) return undefined
      const { local } = entry
      if (zip.readUInt32LE(local) !== 0x04034b50) return undefined
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const data = zip.subarray(start, start + entry.compressed)
      if (entry.method === 0) return data.length <= maxBytes ? Buffer.from(data) : undefined
      if (entry.method !== 8) return undefined
      try {
        return inflateRawSync(data, { maxOutputLength: maxBytes })
      } catch {
        return undefined
      }
    }
  }
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // The record is 22 bytes plus a comment of at most 64 KB, at the very end.
  const stop = Math.max(0, zip.length - 22 - 0xffff)
  for (let i = zip.length - 22; i >= stop; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}
