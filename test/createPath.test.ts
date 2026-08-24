import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPath, renamePath } from '../src/main/files.ts'

const scratch = async (): Promise<string> => mkdtemp(join(tmpdir(), 'carbon-create-'))

test('creates an empty file', async () => {
  const dir = await scratch()
  const result = await createPath(dir, 'notes.md', 'file')
  assert.equal(result.ok, true)
  assert.equal(await readFile(join(dir, 'notes.md'), 'utf8'), '')
})

test('creates a folder', async () => {
  const dir = await scratch()
  const result = await createPath(dir, 'src', 'dir')
  assert.equal(result.ok, true)
  assert.equal((await stat(join(dir, 'src'))).isDirectory(), true)
})

test('a name with slashes makes the folders on the way', async () => {
  const dir = await scratch()
  const result = await createPath(dir, 'lib/deep/util.ts', 'file')
  assert.equal(result.ok, true)
  assert.equal((await stat(join(dir, 'lib', 'deep'))).isDirectory(), true)
  assert.equal(await readFile(join(dir, 'lib/deep/util.ts'), 'utf8'), '')
})

test('refuses to overwrite an existing file', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'keep.txt'), 'precious')
  const result = await createPath(dir, 'keep.txt', 'file')
  assert.equal(result.ok, false)
  // The point of the refusal: the bytes are still there.
  assert.equal(await readFile(join(dir, 'keep.txt'), 'utf8'), 'precious')
})

test('refuses to climb out of the folder', async () => {
  const dir = await scratch()
  for (const name of ['../escaped.txt', 'a/../../escaped.txt', '..', './x']) {
    const result = await createPath(dir, name, 'file')
    assert.equal(result.ok, false, `expected "${name}" to be refused`)
  }
  assert.equal(await stat(join(dir, '..', 'escaped.txt')).then(() => true, () => false), false)
})

test('refuses an absolute path', async () => {
  const dir = await scratch()
  const result = await createPath(dir, '/tmp/carbon-should-not-exist.txt', 'file')
  assert.equal(result.ok, false)
})

test('refuses an empty or whitespace-only name', async () => {
  const dir = await scratch()
  assert.equal((await createPath(dir, '', 'file')).ok, false)
  assert.equal((await createPath(dir, '   ', 'file')).ok, false)
})

test('a trailing slash is tolerated on a folder name', async () => {
  const dir = await scratch()
  const result = await createPath(dir, 'assets/', 'dir')
  assert.equal(result.ok, true)
  assert.equal((await stat(join(dir, 'assets'))).isDirectory(), true)
})

// ---- rename ----

test('renames a file', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'old.txt'), 'body')
  const result = await renamePath(join(dir, 'old.txt'), 'new.txt')
  assert.equal(result.ok, true)
  assert.equal(await readFile(join(dir, 'new.txt'), 'utf8'), 'body')
  assert.equal(await stat(join(dir, 'old.txt')).then(() => true, () => false), false)
})

test('a name with slashes moves the file, creating folders on the way', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'x.ts'), 'body')
  const result = await renamePath(join(dir, 'x.ts'), 'lib/deep/x.ts')
  assert.equal(result.ok, true)
  assert.equal(await readFile(join(dir, 'lib/deep/x.ts'), 'utf8'), 'body')
})

test('refuses to rename onto an existing file', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'a.txt'), 'a')
  await writeFile(join(dir, 'b.txt'), 'b')
  const result = await renamePath(join(dir, 'a.txt'), 'b.txt')
  assert.equal(result.ok, false)
  // Neither side moved.
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'a')
  assert.equal(await readFile(join(dir, 'b.txt'), 'utf8'), 'b')
})

test('allows a case-only rename', async () => {
  // On a case-insensitive filesystem the target "exists" — it is the same file
  // — so a naive existence check refuses the first rename every Mac user tries.
  const dir = await scratch()
  await writeFile(join(dir, 'Readme.md'), 'hi')
  const result = await renamePath(join(dir, 'Readme.md'), 'README.md')
  assert.equal(result.ok, true)
  assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), 'hi')
})

test('renaming to the same name is a no-op, not an error', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'same.txt'), 'v')
  const result = await renamePath(join(dir, 'same.txt'), 'same.txt')
  assert.equal(result.ok, true)
  assert.equal(await readFile(join(dir, 'same.txt'), 'utf8'), 'v')
})

test('refuses to rename out of the parent folder', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'stay.txt'), 'v')
  for (const name of ['../escaped.txt', '/tmp/escaped.txt', '..', '']) {
    assert.equal((await renamePath(join(dir, 'stay.txt'), name)).ok, false, `refused: ${name}`)
  }
  assert.equal(await readFile(join(dir, 'stay.txt'), 'utf8'), 'v')
})

test('renames a folder with its contents', async () => {
  const dir = await scratch()
  await createPath(dir, 'src/inner.ts', 'file')
  const result = await renamePath(join(dir, 'src'), 'lib')
  assert.equal(result.ok, true)
  assert.equal((await stat(join(dir, 'lib/inner.ts'))).isFile(), true)
})
