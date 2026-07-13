import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  readImageOnce,
  invalidateLocalImages,
  subscribeImageEpoch,
  getImageEpoch,
  __resetImageCacheForTest
} from '../src/renderer/src/lib/imageCache.ts'

beforeEach(() => __resetImageCacheForTest())

/** A reader that counts calls and returns a per-path value. */
function reader(values: Record<string, string | null>) {
  const calls: string[] = []
  const read = (p: string): Promise<string | null> => {
    calls.push(p)
    return Promise.resolve(values[p] ?? null)
  }
  return { read, calls }
}

test('a successful read is cached — a second read does not hit the loader', async () => {
  const { read, calls } = reader({ '/a.png': 'data:img-a' })
  const a = await readImageOnce('/a.png', read)
  const b = await readImageOnce('/a.png', read)
  assert.equal(a, 'data:img-a')
  assert.equal(b, 'data:img-a')
  assert.deepEqual(calls, ['/a.png']) // loaded once
})

test('a miss (null) is not cached — a later read retries', async () => {
  const values: Record<string, string | null> = { '/late.png': null }
  const { read, calls } = reader(values)
  assert.equal(await readImageOnce('/late.png', read), null)
  values['/late.png'] = 'data:appeared' // file shows up later
  assert.equal(await readImageOnce('/late.png', read), 'data:appeared')
  assert.deepEqual(calls, ['/late.png', '/late.png']) // retried
})

test('invalidateLocalImages drops cached hits so the next read reloads', async () => {
  const values: Record<string, string | null> = { '/logo.png': 'data:v1' }
  const { read, calls } = reader(values)
  assert.equal(await readImageOnce('/logo.png', read), 'data:v1')
  values['/logo.png'] = 'data:v2' // overwritten on disk
  // Without invalidation the cache would still serve v1:
  assert.equal(await readImageOnce('/logo.png', read), 'data:v1')
  invalidateLocalImages()
  assert.equal(await readImageOnce('/logo.png', read), 'data:v2') // fresh bytes
  assert.deepEqual(calls, ['/logo.png', '/logo.png']) // one load per epoch
})

test('invalidateLocalImages increments the epoch (drives useSyncExternalStore re-reads)', () => {
  const start = getImageEpoch()
  invalidateLocalImages()
  invalidateLocalImages()
  assert.equal(getImageEpoch(), start + 2)
})

test('subscribers are notified on invalidation and can unsubscribe', () => {
  let hits = 0
  const unsub = subscribeImageEpoch(() => hits++)
  invalidateLocalImages()
  invalidateLocalImages()
  assert.equal(hits, 2)
  unsub()
  invalidateLocalImages()
  assert.equal(hits, 2) // no longer notified
})

test('an in-flight read is shared (loader called once for concurrent callers)', async () => {
  const { read, calls } = reader({ '/x.png': 'data:x' })
  const [a, b] = await Promise.all([readImageOnce('/x.png', read), readImageOnce('/x.png', read)])
  assert.equal(a, 'data:x')
  assert.equal(b, 'data:x')
  assert.deepEqual(calls, ['/x.png'])
})
