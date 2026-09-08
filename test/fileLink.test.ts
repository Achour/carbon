import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileLinkPath, isBareFileLineRef } from '../src/renderer/src/lib/fileLink.ts'

test('takes the shape Codex cites its sources in', () => {
  // Read off a real Codex turn: absolute path, `:line` suffix.
  assert.equal(
    fileLinkPath('/Users/achour/Personal/temp/orbit/counter.ts:1'),
    '/Users/achour/Personal/temp/orbit/counter.ts'
  )
  assert.equal(fileLinkPath('/a/b/counter.ts:12:4'), '/a/b/counter.ts')
  assert.equal(fileLinkPath('/a/b/counter.ts'), '/a/b/counter.ts')
})

test('takes relative destinations, without the leading ./', () => {
  assert.equal(fileLinkPath('counter.ts'), 'counter.ts')
  assert.equal(fileLinkPath('./src/lib/fileLink.ts'), 'src/lib/fileLink.ts')
  assert.equal(fileLinkPath('src/lib/fileLink.ts:3'), 'src/lib/fileLink.ts')
})

test('a bare basename with a line suffix is not a scheme', () => {
  assert.equal(fileLinkPath('counter.ts:1'), 'counter.ts')
})

test('leaves real links alone', () => {
  assert.equal(fileLinkPath('https://example.com/a.ts'), null)
  assert.equal(fileLinkPath('http://example.com/a.ts:1'), null)
  assert.equal(fileLinkPath('mailto:someone@example.com'), null)
  assert.equal(fileLinkPath('data:image/png;base64,AAA'), null)
  assert.equal(fileLinkPath('vscode://file/a.ts'), null)
  assert.equal(fileLinkPath('#section'), null)
  assert.equal(fileLinkPath(''), null)
  assert.equal(fileLinkPath('   '), null)
})

test('a destination naming no file is not a candidate', () => {
  assert.equal(fileLinkPath('guide'), null)
  assert.equal(fileLinkPath('docs/guide'), null)
  assert.equal(fileLinkPath('/a/b/'), null)
})

test('undoes the href encoding, including a path with a space', () => {
  assert.equal(fileLinkPath('/a/my%20notes.md'), '/a/my notes.md')
  // Invalid encoding is taken as written rather than dropped.
  assert.equal(fileLinkPath('/a/100%.md'), '/a/100%.md')
})

test('reads a local file:// URL', () => {
  assert.equal(fileLinkPath('file:///a/b/counter.ts:1'), '/a/b/counter.ts')
  assert.equal(fileLinkPath('file://host/a/b/counter.ts'), null)
})

test('adds back only the destination the default sanitizer blanks', () => {
  // React Markdown reads everything before the first colon as a scheme when no
  // `/` comes first, so this one is `''` by the time a renderer sees it.
  assert.equal(isBareFileLineRef('counter.ts:1'), true)
  assert.equal(isBareFileLineRef('counter.ts:12:4'), true)
  // Everything else is either already safe or must stay blank.
  assert.equal(isBareFileLineRef('counter.ts'), false)
  assert.equal(isBareFileLineRef('src/counter.ts:1'), false)
  assert.equal(isBareFileLineRef('javascript:alert(1)'), false)
  assert.equal(isBareFileLineRef('java.script:1'), true) // names a file, not a scheme
  assert.equal(isBareFileLineRef('https://example.com:8080'), false)
  assert.equal(isBareFileLineRef('mailto:someone@example.com'), false)
})
