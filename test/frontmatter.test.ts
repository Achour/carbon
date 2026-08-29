import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitFrontmatter } from '../src/renderer/src/lib/frontmatter.ts'

test('splits a typical agent file', () => {
  const fm = splitFrontmatter(
    '---\nname: explainer\ndescription: Use when the user asks "explain", "why", or "in simple terms".\ntools: Read, Glob, Grep\nmodel: opus\n---\n\nYou explain things.\n'
  )
  assert.ok(fm)
  assert.deepEqual(
    fm.pairs.map((p) => p.key),
    ['name', 'description', 'tools', 'model']
  )
  // Every colon after the first belongs to the value.
  assert.equal(
    fm.pairs[1].value,
    'Use when the user asks "explain", "why", or "in simple terms".'
  )
  assert.equal(fm.body, 'You explain things.\n')
})

test('a value carrying colons is not split further', () => {
  const fm = splitFrontmatter('---\nsee: https://example.com/a:b\n---\nbody')
  assert.equal(fm?.pairs[0].value, 'https://example.com/a:b')
})

test('indented lines continue the key above them', () => {
  const fm = splitFrontmatter('---\nname: x\nmetadata:\n  type: user\n  tags:\n    - a\n---\nbody')
  assert.ok(fm)
  assert.equal(fm.pairs.length, 2)
  assert.equal(fm.pairs[1].key, 'metadata')
  assert.equal(fm.pairs[1].value, 'type: user\ntags:\n  - a')
})

test('a block scalar keeps its shape', () => {
  const fm = splitFrontmatter('---\ndescription: |\n  line one\n  line two\n---\nbody')
  assert.equal(fm?.pairs[0].value, '|\nline one\nline two')
})

test('a top-level list item continues the key above it', () => {
  const fm = splitFrontmatter('---\ntools:\n- Read\n- Grep\n---\nbody')
  assert.equal(fm?.pairs[0].value, '- Read\n- Grep')
})

test('no closing fence is a thematic break, not frontmatter', () => {
  assert.equal(splitFrontmatter('---\nname: x\n\nsome prose'), null)
})

test('a fence that is not the first line is not frontmatter', () => {
  assert.equal(splitFrontmatter('\n---\nname: x\n---\n'), null)
  assert.equal(splitFrontmatter('# Title\n\n---\nname: x\n---\n'), null)
})

test('fenced prose with no key/value pairs renders normally', () => {
  assert.equal(splitFrontmatter('---\njust some prose\n---\nbody'), null)
  assert.equal(splitFrontmatter('---\n---\nbody'), null)
})

test('CRLF and a BOM survive', () => {
  const fm = splitFrontmatter('﻿---\r\nname: x\r\n---\r\n\r\nbody\r\n')
  assert.ok(fm)
  assert.equal(fm.pairs[0].key, 'name')
  assert.equal(fm.pairs[0].value, 'x')
  assert.equal(fm.body, 'body\n')
})

test('blank lines inside the block are ignored', () => {
  const fm = splitFrontmatter('---\nname: x\n\nmodel: opus\n---\nbody')
  assert.equal(fm?.pairs.length, 2)
})

test('an empty value is kept', () => {
  const fm = splitFrontmatter('---\nname:\nmodel: opus\n---\nbody')
  assert.equal(fm?.pairs[0].value, '')
})

test('the body keeps its own horizontal rules', () => {
  const fm = splitFrontmatter('---\nname: x\n---\n\nfirst\n\n---\n\nsecond\n')
  assert.equal(fm?.body, 'first\n\n---\n\nsecond\n')
})
