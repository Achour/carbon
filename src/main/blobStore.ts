import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
// Relative and .ts-extensioned, like store.ts: runtime imports `node --test`
// and the migration worker both resolve without a bundler.
import { blobRef, isBlobRef } from '../shared/blobRef.ts'
import type {
  AssistantPart,
  Attachment,
  ChatEvent,
  ChatMessage,
  ToolPart
} from '../shared/types.ts'

/**
 * Images live beside the transcript, not in it. Measured on a real 3.4 GB
 * `chats.db`, base64 images were 74% of every message body by volume; held
 * inline they rode every `JSON.parse` of a window, every write pass and every
 * IPC clone, and a renderer that had scrolled through a screenshot-heavy chat
 * held ~0.5 GB more than the same chat with its images out of line.
 *
 * So an image leaves the message at the three boundaries it used to cross
 * whole: a `ChatEvent` leaving main (`externalizeEvent`), a window of history
 * leaving main (`externalizeMessages`) and a row being written (`Store`'s
 * encoder). Each boundary works on a *copy*: the session that produced a
 * message keeps its own objects untouched, because an attachment can still be
 * on its way to the provider (a send held in `sendChain` behind a handoff
 * brief) when its echo is emitted.
 *
 * The way back is `inline`, at the two places main hands attachments to a
 * session (`ChatManager.deliver` / `steer`): a message edited and resent, or
 * replayed after a restart, carries refs, and every provider reads `data`.
 */

/** Base64 this short stays inline: a file per tiny icon costs more than it saves. */
export const INLINE_MAX = 1024

/** `holder` is the object the base64 sits on, for a store that remembers its ref. */
export type PutImage = (mediaType: string, base64: string, holder?: object) => string | null
export type ReadImage = (ref: string) => string | null

type ImageHolder = { mediaType?: string; data?: string; ref?: string }

/** The image with its bytes moved out, or itself when there is nothing to move. */
export function externalizeImage<T extends ImageHolder>(img: T, put: PutImage): T {
  if (!img || typeof img.data !== 'string') return img
  // Both set: the ref already names these bytes.
  if (isBlobRef(img.ref)) {
    const { data: _data, ...rest } = img
    return rest as T
  }
  if (img.data.length <= INLINE_MAX || !img.mediaType) return img
  const ref = put(img.mediaType, img.data, img)
  // A failed write keeps the image inline: never trade the picture for a name
  // that points at nothing.
  if (!ref) return img
  const { data: _data, ...rest } = img
  return { ...rest, ref } as T
}

function mapSame<T>(list: T[], f: (x: T) => T): T[] {
  let out: T[] | null = null
  for (let i = 0; i < list.length; i++) {
    const next = f(list[i])
    if (next !== list[i]) {
      out ??= list.slice()
      out[i] = next
    }
  }
  return out ?? list
}

function externalizeTool(part: ToolPart, put: PutImage): ToolPart {
  const images = part.outputImages ? mapSame(part.outputImages, (i) => externalizeImage(i, put)) : undefined
  const children = part.children ? externalizeParts(part.children, put) : undefined
  if (images === part.outputImages && children === part.children) return part
  return {
    ...part,
    ...(images ? { outputImages: images } : {}),
    ...(children ? { children } : {})
  }
}

/** Parts with their images moved out; the same array when none had any. */
export function externalizeParts(parts: AssistantPart[], put: PutImage): AssistantPart[] {
  // Rows written before the parts were typed strictly can hold a null.
  return mapSame(parts, (p) => (p && p.type === 'tool' ? externalizeTool(p, put) : p))
}

export function externalizeMessage(m: ChatMessage, put: PutImage): ChatMessage {
  if (!m) return m
  if (m.role === 'user' && m.attachments?.length) {
    const attachments = mapSame(m.attachments, (a) => externalizeImage(a, put))
    return attachments === m.attachments ? m : { ...m, attachments }
  }
  if (m.role === 'assistant' && Array.isArray(m.parts)) {
    const parts = externalizeParts(m.parts, put)
    return parts === m.parts ? m : { ...m, parts }
  }
  return m
}

export function externalizeMessages(list: ChatMessage[], put: PutImage): ChatMessage[] {
  return mapSame(list, (m) => externalizeMessage(m, put))
}

/** The event as the renderer and the phone should get it. */
export function externalizeEvent(ev: ChatEvent, put: PutImage): ChatEvent {
  switch (ev.type) {
    case 'message': {
      const message = externalizeMessage(ev.message, put)
      return message === ev.message ? ev : { ...ev, message }
    }
    case 'part': {
      const part = ev.part?.type === 'tool' ? externalizeTool(ev.part, put) : ev.part
      return part === ev.part ? ev : { ...ev, part }
    }
    case 'tool-update': {
      const { outputImages, children } = ev.patch
      const images = outputImages ? mapSame(outputImages, (i) => externalizeImage(i, put)) : outputImages
      const kids = children ? externalizeParts(children, put) : children
      if (images === outputImages && kids === children) return ev
      return {
        ...ev,
        patch: {
          ...ev.patch,
          ...(images ? { outputImages: images } : {}),
          ...(kids ? { children: kids } : {})
        }
      }
    }
    default:
      return ev
  }
}

/**
 * Attachments with their bytes back, for a provider. An image whose file is
 * gone stays as it is: every provider skips an image with no `data`, which is
 * the honest outcome for bytes that no longer exist.
 */
export function inlineAttachments(list: Attachment[], read: ReadImage): Attachment[] {
  return mapSame(list, (a) => {
    if (typeof a.data === 'string' || !isBlobRef(a.ref)) return a
    const data = read(a.ref)
    if (data === null) {
      console.warn(`[blobs] image ${a.ref} is missing; sending ${a.name} without it`)
      return a
    }
    return { ...a, data }
  })
}

/**
 * The files, under `userData/blobs/<first two hex>/<ref>`. Writes are
 * idempotent (the name is the content) and atomic (temp file, then rename), so
 * two instances sharing one `userData`, or the migration thread beside the main
 * one, can write the same image at once without either seeing half a file.
 */
export class BlobStore {
  /** Refs this process has written or seen on disk: the second put is a hash, not a stat. */
  private known = new Set<string>()
  /**
   * Each image holder's ref, so the same object encoded again hashes nothing. A
   * session's live message is serialized on every debounced write
   * (`saveChatSoon`) and emitted on every part update while its session still
   * holds the image inline; without this each pass would re-hash every
   * screenshot it carries. The base64 is kept beside the ref and compared, so
   * a holder whose `data` was replaced is hashed afresh rather than misnamed.
   */
  private refs = new WeakMap<object, { data: string; ref: string }>()

  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  pathOf(ref: string): string | null {
    return isBlobRef(ref) ? join(this.dir, ref.slice(0, 2), ref) : null
  }

  /** Store the bytes; their ref, or null when they could not be written. */
  put(mediaType: string, base64: string): string | null {
    try {
      const bytes = Buffer.from(base64, 'base64')
      if (!bytes.length) return null
      const ref = blobRef(createHash('sha256').update(bytes).digest('hex'), mediaType)
      if (this.known.has(ref)) return ref
      const file = this.pathOf(ref)!
      if (!existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
        writeFileSync(tmp, bytes)
        renameSync(tmp, file)
      }
      this.known.add(ref)
      return ref
    } catch (err) {
      console.warn('[blobs] could not store an image:', err)
      return null
    }
  }

  read(ref: string): Buffer | null {
    const file = this.pathOf(ref)
    if (!file) return null
    try {
      return readFileSync(file)
    } catch {
      return null
    }
  }

  readBase64(ref: string): string | null {
    return this.read(ref)?.toString('base64') ?? null
  }

  private readonly cachedPut: PutImage = (mediaType, base64, holder) => {
    const hit = holder ? this.refs.get(holder) : undefined
    if (hit && hit.data === base64) return hit.ref
    const ref = this.put(mediaType, base64)
    if (ref && holder) this.refs.set(holder, { data: base64, ref })
    return ref
  }

  message(m: ChatMessage): ChatMessage {
    return externalizeMessage(m, this.cachedPut)
  }

  messages(list: ChatMessage[]): ChatMessage[] {
    return externalizeMessages(list, this.cachedPut)
  }

  event(ev: ChatEvent): ChatEvent {
    return externalizeEvent(ev, this.cachedPut)
  }

  inline(list: Attachment[] | undefined): Attachment[] | undefined {
    return list?.length ? inlineAttachments(list, (ref) => this.readBase64(ref)) : list
  }
}

/** Every ref named anywhere in a message body, read without parsing it. */
export function refsIn(body: string, into: Set<string>): void {
  for (const m of body.matchAll(/"ref":"([0-9a-f]{64}\.[a-z0-9]{2,5})"/g)) into.add(m[1])
}

/**
 * Delete stored images no row names any more, once they are old enough that no
 * session can still be holding an unpersisted message that names one. Returns
 * how many files and bytes went.
 */
export function sweepBlobs(
  dir: string,
  referenced: Set<string>,
  graceMs: number,
  now = Date.now()
): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  let shards: string[]
  try {
    shards = readdirSync(dir)
  } catch {
    return { files, bytes }
  }
  for (const shard of shards) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue
    const sub = join(dir, shard)
    let names: string[]
    try {
      names = readdirSync(sub)
    } catch {
      continue
    }
    for (const name of names) {
      const file = join(sub, name)
      // A temp file is a write that died mid-way; a ref still named is live.
      const stray = name.endsWith('.tmp')
      if (!stray && (!isBlobRef(name) || referenced.has(name))) continue
      try {
        const info = statSync(file)
        if (now - info.mtimeMs < graceMs) continue
        unlinkSync(file)
        files++
        bytes += info.size
      } catch {
        // Gone already, or not ours to delete.
      }
    }
  }
  return { files, bytes }
}

