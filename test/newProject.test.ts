import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectFolder, projectNameError } from '../src/main/newProject.ts'

const scratch = async (): Promise<string> => mkdtemp(join(tmpdir(), 'carbon-project-'))

test('a plain name is a project name', () => {
  assert.equal(projectNameError('nimbus'), null)
  assert.equal(projectNameError('My App 2'), null)
})

test('names that would leave the folder, or hide, are refused', () => {
  for (const bad of ['', '  ', '.', '..', 'a/b', '../up', 'a\\b', '.secret', 'a:b', 'x'.repeat(101)]) {
    assert.notEqual(projectNameError(bad), null, bad)
  }
})

test('creates the folder one level down', async () => {
  const dir = await scratch()
  const result = await createProjectFolder(dir, '  weather  ')
  assert.deepEqual(result, { ok: true, path: join(dir, 'weather') })
  assert.ok((await stat(join(dir, 'weather'))).isDirectory())
})

test('never takes over a folder that is already there', async () => {
  const dir = await scratch()
  await mkdir(join(dir, 'taken'))
  const result = await createProjectFolder(dir, 'taken')
  assert.equal(result.ok, false)
})

test('a missing location is an error, not a mkdir -p', async () => {
  const dir = await scratch()
  const result = await createProjectFolder(join(dir, 'gone'), 'app')
  assert.equal(result.ok, false)
})

test('a relative location is refused', async () => {
  const result = await createProjectFolder('relative/dir', 'app')
  assert.equal(result.ok, false)
})
