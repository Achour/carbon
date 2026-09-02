import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePartialJson } from '../src/main/partialJson.ts'

test('a complete document parses as itself', () => {
  assert.deepEqual(parsePartialJson('{"command":"ls","description":"List"}'), {
    command: 'ls',
    description: 'List'
  })
})

test('an open string value is closed', () => {
  assert.deepEqual(parsePartialJson('{"command": "cd /Users/achour && npm te'), {
    command: 'cd /Users/achour && npm te'
  })
})

test('a key with no value yet gets null', () => {
  assert.deepEqual(parsePartialJson('{"comm'), { comm: null })
  assert.deepEqual(parsePartialJson('{"command"'), { command: null })
  assert.deepEqual(parsePartialJson('{"command":'), { command: null })
  assert.deepEqual(parsePartialJson('{"command": '), { command: null })
})

test('a dangling comma is dropped', () => {
  assert.deepEqual(parsePartialJson('{"file_path": "/a.ts", '), { file_path: '/a.ts' })
})

test('a half-written escape is backed off', () => {
  assert.deepEqual(parsePartialJson('{"old_string": "a\\'), { old_string: 'a' })
  assert.deepEqual(parsePartialJson('{"old_string": "a\\u00'), { old_string: 'a' })
  assert.deepEqual(parsePartialJson('{"old_string": "a\\n'), { old_string: 'a\n' })
})

test('nested containers close in order', () => {
  assert.deepEqual(parsePartialJson('{"edits": [{"old": "x", "new": "y"}, {"old": "z'), {
    edits: [{ old: 'x', new: 'y' }, { old: 'z' }]
  })
  assert.deepEqual(parsePartialJson('{"a": [1, 2'), { a: [1, 2] })
})

test('an unfinishable literal is cut back to the last safe point', () => {
  assert.deepEqual(parsePartialJson('{"a": "x", "b": tr'), { a: 'x' })
  assert.deepEqual(parsePartialJson('{"a": "x", "b": -'), { a: 'x' })
})

test('nothing parseable yields undefined', () => {
  assert.equal(parsePartialJson(''), undefined)
  assert.equal(parsePartialJson('   '), undefined)
  assert.equal(parsePartialJson('}'), undefined)
})

test('the second field streams in beside a complete first one', () => {
  assert.deepEqual(parsePartialJson('{"file_path": "/x/y.ts", "old_string": "const a'), {
    file_path: '/x/y.ts',
    old_string: 'const a'
  })
})
