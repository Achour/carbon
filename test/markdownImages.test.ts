import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  explicitMarkdownImageTargets,
  normalizeMarkdownImageTarget
} from '../src/renderer/src/lib/markdownImages.ts'

test('finds inline Markdown image destinations but not ordinary links', () => {
  const targets = explicitMarkdownImageTargets(
    '![shot](/private/tmp/shot.jpg)\n\nSaved at [shot.jpg](/private/tmp/shot.jpg).'
  )
  assert.deepEqual([...targets], ['/private/tmp/shot.jpg'])
})

test('normalizes encoded and angle-bracket image destinations for dedupe', () => {
  const targets = explicitMarkdownImageTargets('![shot](</private/tmp/my shot.png> "Latest")')
  assert.equal(targets.has(normalizeMarkdownImageTarget('/private/tmp/my%20shot.png')), true)
})

test('ignores a normal local image link when there is no explicit image', () => {
  assert.deepEqual(
    [...explicitMarkdownImageTargets('[shot.png](/private/tmp/shot.png)')],
    []
  )
})
