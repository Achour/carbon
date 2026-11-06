import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AssistantMessage, ChatData, ChatEvent, ChatMessage, UserMessage } from '../src/shared/types.ts'
import {
  BlobStore,
  INLINE_MAX,
  externalizeEvent,
  externalizeImage,
  externalizeMessage,
  inlineAttachments,
  refsIn,
  sweepBlobs
} from '../src/main/blobStore.ts'
import { blobMediaType, blobRef, isBlobRef } from '../src/shared/blobRef.ts'
import { Store } from '../src/main/store.ts'

const dir = (): string => mkdtempSync(join(tmpdir(), 'carbon-blobs-'))
// Big enough to leave the message, and distinct per call.
let n = 0
const big = (): string => Buffer.from(`image-${++n}-`.repeat(200)).toString('base64')
const fakePut = (): { put: (t: string, d: string) => string; calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    put: (_t, d) => {
      calls.push(d)
      return `${String(calls.length).padStart(64, '0')}.png`
    }
  }
}

test('a ref is a sha256 and a known extension, and nothing else', () => {
  const ref = blobRef('a'.repeat(64), 'image/png')
  assert.equal(ref, `${'a'.repeat(64)}.png`)
  assert.ok(isBlobRef(ref))
  assert.equal(blobRef('b'.repeat(64), 'image/jpeg').slice(-4), '.jpg')
  assert.equal(blobMediaType(ref), 'image/png')
  for (const bad of ['../../etc/passwd', `${'a'.repeat(63)}.png`, `${'A'.repeat(64)}.png`, `${'a'.repeat(64)}.exe`, `${'a'.repeat(64)}/x.png`]) {
    assert.equal(isBlobRef(bad), false, bad)
  }
})

test('an image leaves its holder as a ref; small ones and the original stay put', () => {
  const { put, calls } = fakePut()
  const img = { mediaType: 'image/png', data: big() }
  const out = externalizeImage(img, put)
  assert.equal(out.data, undefined)
  assert.ok(isBlobRef(out.ref))
  assert.equal(img.data.length > INLINE_MAX, true)
  assert.ok(img.data, 'the session keeps its own object untouched')
  const tiny = { mediaType: 'image/png', data: 'iVBORw0K' }
  assert.equal(externalizeImage(tiny, put), tiny)
  assert.equal(calls.length, 1)
})

test('a failed write keeps the image inline rather than naming nothing', () => {
  const img = { mediaType: 'image/png', data: big() }
  assert.equal(externalizeImage(img, () => null), img)
})

test('an image holding both keeps the ref and drops the bytes, without writing again', () => {
  const { put, calls } = fakePut()
  const ref = `${'c'.repeat(64)}.png`
  const out = externalizeImage({ mediaType: 'image/png', data: big(), ref }, put)
  assert.deepEqual(out, { mediaType: 'image/png', ref })
  assert.equal(calls.length, 0)
})

test('a message with no images comes back as the same object', () => {
  const { put } = fakePut()
  const user: ChatMessage = { id: 'u', role: 'user', text: 'hi', ts: 1, attachments: [{ id: 'f', kind: 'file', name: 'a.ts', path: '/a.ts' }] }
  const asst: ChatMessage = { id: 'a', role: 'assistant', ts: 1, parts: [{ type: 'text', text: 'x' }, { type: 'tool', toolUseId: 't', name: 'Bash', status: 'success', output: 'ok' }] }
  assert.equal(externalizeMessage(user, put), user)
  assert.equal(externalizeMessage(asst, put), asst)
})

test('images are found in attachments, tool outputs and a sub-agent’s own calls', () => {
  const { put } = fakePut()
  const user: UserMessage = {
    id: 'u',
    role: 'user',
    text: 'look',
    ts: 1,
    attachments: [
      { id: 'i', kind: 'image', name: 'shot.png', mediaType: 'image/png', data: big() },
      { id: 'f', kind: 'file', name: 'a.ts', path: '/a.ts' }
    ]
  }
  const outUser = externalizeMessage(user, put) as UserMessage
  assert.ok(isBlobRef(outUser.attachments![0].ref))
  assert.equal(outUser.attachments![0].data, undefined)
  assert.equal(outUser.attachments![1], user.attachments![1])

  const asst: AssistantMessage = {
    id: 'a',
    role: 'assistant',
    ts: 1,
    parts: [
      { type: 'text', text: 'plain' },
      {
        type: 'tool',
        toolUseId: 'agent',
        name: 'Agent',
        status: 'running',
        children: [{ type: 'tool', toolUseId: 'c', name: 'Read', status: 'success', outputImages: [{ mediaType: 'image/png', data: big() }] }]
      }
    ]
  }
  const outAsst = externalizeMessage(asst, put) as AssistantMessage
  assert.equal(outAsst.parts[0], asst.parts[0])
  const child = (outAsst.parts[1] as { children: { outputImages: { data?: string; ref?: string }[] }[] }).children[0]
  assert.ok(isBlobRef(child.outputImages[0].ref))
  assert.equal(child.outputImages[0].data, undefined)
  assert.ok((asst.parts[1] as { children: { outputImages: { data?: string }[] }[] }).children[0].outputImages[0].data)
})

test('message, part and tool-update events carry refs; others pass through', () => {
  const { put } = fakePut()
  const part = { type: 'tool' as const, toolUseId: 't', name: 'preview_screenshot', status: 'success' as const, outputImages: [{ mediaType: 'image/png', data: big() }] }
  const ev1 = externalizeEvent({ type: 'part', chatId: 'c', messageId: 'm', partIndex: 0, part }, put) as Extract<ChatEvent, { type: 'part' }>
  assert.ok(isBlobRef((ev1.part as typeof part).outputImages[0].ref))
  const ev2 = externalizeEvent(
    { type: 'tool-update', chatId: 'c', messageId: 'm', toolUseId: 't', patch: { status: 'success', outputImages: [{ mediaType: 'image/png', data: big() }] } },
    put
  ) as Extract<ChatEvent, { type: 'tool-update' }>
  assert.ok(isBlobRef(ev2.patch.outputImages![0].ref))
  assert.equal(ev2.patch.status, 'success')
  const status: ChatEvent = { type: 'status', chatId: 'c', status: 'idle' }
  assert.equal(externalizeEvent(status, put), status)
})

test('the store writes each image once, by content, and reads it back', () => {
  const blobs = new BlobStore(dir())
  const data = big()
  const a = blobs.put('image/png', data)!
  const b = blobs.put('image/png', data)!
  assert.equal(a, b)
  assert.ok(existsSync(blobs.pathOf(a)!))
  assert.equal(blobs.readBase64(a), data)
  assert.equal(blobs.pathOf('../x.png'), null)
  assert.equal(blobs.read(`${'d'.repeat(64)}.png`), null)
})

test('attachments get their bytes back before a provider sees them', () => {
  const blobs = new BlobStore(dir())
  const data = big()
  const ref = blobs.put('image/png', data)!
  const list = [
    { id: 'a', kind: 'image' as const, name: 'a.png', mediaType: 'image/png', ref },
    { id: 'b', kind: 'image' as const, name: 'b.png', mediaType: 'image/png', ref: `${'e'.repeat(64)}.png` },
    { id: 'c', kind: 'file' as const, name: 'c.ts', path: '/c.ts' }
  ]
  const out = inlineAttachments(list, (r) => blobs.readBase64(r))
  assert.equal(out[0].data, data)
  assert.equal(out[1], list[1], 'a missing file leaves the image as it was')
  assert.equal(out[2], list[2])
  assert.equal(blobs.inline(undefined), undefined)
})

test('the sweep deletes old, unnamed images and dead temp files, and nothing else', () => {
  const root = dir()
  const blobs = new BlobStore(root)
  const keep = blobs.put('image/png', big())!
  const drop = blobs.put('image/png', big())!
  const young = blobs.put('image/png', big())!
  const tmp = join(root, keep.slice(0, 2), `${keep}.abc.tmp`)
  writeFileSync(tmp, 'half')
  mkdirSync(join(root, 'zz'), { recursive: true })
  writeFileSync(join(root, 'zz', 'not-ours'), 'x')
  const old = (Date.now() - 10_000) / 1000
  for (const f of [blobs.pathOf(keep)!, blobs.pathOf(drop)!, tmp]) utimesSync(f, old, old)

  const named = new Set<string>()
  refsIn(JSON.stringify({ attachments: [{ ref: keep }], other: { ref: young } }), named)
  named.delete(young)
  const gone = sweepBlobs(root, named, 5_000)
  assert.equal(gone.files, 2)
  assert.ok(existsSync(blobs.pathOf(keep)!))
  assert.ok(!existsSync(blobs.pathOf(drop)!))
  assert.ok(existsSync(blobs.pathOf(young)!), 'inside the grace period')
  assert.ok(!existsSync(tmp))
  assert.deepEqual(readdirSync(join(root, 'zz')), ['not-ours'])
})

test('the store never writes base64 into a row, and leaves the session’s objects alone', async () => {
  const userData = dir()
  mkdirSync(join(userData, 'chats'), { recursive: true })
  const store = new Store(userData)
  const data = big()
  const chat: ChatData = {
    id: 'chat-img',
    title: 'Images',
    cwd: '/tmp',
    provider: 'claude',
    permissionMode: 'default',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { id: 'u', role: 'user', text: 'see', ts: 1, attachments: [{ id: 'i', kind: 'image', name: 'x.png', mediaType: 'image/png', data }] },
      { id: 'a', role: 'assistant', ts: 2, parts: [{ type: 'tool', toolUseId: 't', name: 'Read', status: 'success', outputImages: [{ mediaType: 'image/png', data }] }] }
    ]
  }
  store.addChat(chat)
  store.saveChat(chat.id)
  await store.flushAll()

  const db = new DatabaseSync(join(userData, 'chats.db'), { readOnly: true })
  const bodies = (db.prepare('SELECT body FROM messages WHERE chat_id = ? ORDER BY seq').all(chat.id) as { body: string }[]).map((r) => r.body)
  db.close()
  assert.equal(bodies.length, 2)
  for (const body of bodies) {
    assert.ok(!body.includes(data.slice(0, 200)), 'no base64 on disk')
    assert.match(body, /"ref":"[0-9a-f]{64}\.png"/)
  }
  // Both images are the same bytes, so one file.
  const refs = new Set<string>()
  for (const body of bodies) refsIn(body, refs)
  assert.equal(refs.size, 1)
  assert.equal(store.blobs.readBase64([...refs][0]), data)
  // The live chat object still holds its bytes: a send may still be reading them.
  assert.equal((chat.messages[0] as UserMessage).attachments![0].data, data)

  const reopened = new Store(userData)
  const loaded = reopened.getChat(chat.id)!
  const att = (loaded.messages[0] as UserMessage).attachments![0]
  assert.equal(att.data, undefined)
  assert.ok(isBlobRef(att.ref))
})
