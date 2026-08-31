import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeActivity } from '../src/renderer/src/lib/toolSummary.ts'

test('names one kind with its verb and count', () => {
  assert.equal(summarizeActivity(['Read']), 'Read 1 file')
  assert.equal(summarizeActivity(['Read', 'Read', 'Read']), 'Read 3 files')
  assert.equal(summarizeActivity(['Edit', 'Edit']), 'Edited 2 files')
  assert.equal(summarizeActivity(['Write']), 'Wrote 1 file')
  assert.equal(summarizeActivity(['Fetch', 'Fetch']), 'Fetched 2 pages')
})

test('a search is named by its noun, with no verb in front of it', () => {
  assert.equal(summarizeActivity(['Grep']), '1 search')
  assert.equal(summarizeActivity(['Grep', 'Glob']), '2 searches')
  // Every way of asking "where is it" is one kind, so a `rg` typed into Bash
  // (label `Search`) counts with the structured ones rather than as its own
  // clause.
  assert.equal(summarizeActivity(['Grep', 'Search', 'Find files']), '3 searches')
})

test('every shell label counts as one "ran" clause', () => {
  assert.equal(summarizeActivity(['Run', 'Git', 'Terminal']), 'Ran 3 commands')
})

test('a mixed run gets a clause per kind, in a fixed order', () => {
  // The order is the *clause* order, not the call order: what the turn changed
  // leads, and its method follows.
  assert.equal(
    summarizeActivity(['Read', 'Read', 'Read', 'Grep', 'Glob', 'Edit']),
    'Edited 1 file, read 3 files, 2 searches'
  )
  assert.equal(summarizeActivity(['Grep', 'Run', 'Read']), 'Ran 1 command, read 1 file, 1 search')
})

test('only the first clause is capitalized', () => {
  assert.equal(summarizeActivity(['Edit', 'Read']), 'Edited 1 file, read 1 file')
  assert.equal(summarizeActivity(['Read', 'Edit']).startsWith('Edited'), true)
})

test('running swings the whole row into the present, not just its last clause', () => {
  assert.equal(summarizeActivity(['Read', 'Read'], true), 'Reading 2 files')
  assert.equal(summarizeActivity(['Edit', 'Read'], true), 'Editing 1 file, reading 1 file')
  // A verbless kind has nothing to conjugate; the spinner carries the motion.
  assert.equal(summarizeActivity(['Grep', 'Grep'], true), '2 searches')
})

test('an unnamed tool keeps its own name when the run is all one of them', () => {
  assert.equal(summarizeActivity(['Skill', 'Skill']), 'Skill ×2')
  assert.equal(summarizeActivity(['Read', 'Skill']), 'Read 1 file, skill ×1')
})

test('a mixed bag of unnamed tools falls back to counting steps', () => {
  assert.equal(summarizeActivity(['Skill', 'Workflow']), '2 steps')
  assert.equal(summarizeActivity(['Read', 'Skill', 'Workflow']), 'Read 1 file, 2 steps')
})

test('a canvas is a result, so it leads the reads that produced it', () => {
  assert.equal(summarizeActivity(['Canvas']), 'Wrote 1 canvas')
  assert.equal(summarizeActivity(['Read', 'Read', 'Canvas']), 'Wrote 1 canvas, read 2 files')
  // Its own noun rather than folding into Write's "files": a canvas is not one.
  assert.equal(summarizeActivity(['Write', 'Canvas']), 'Wrote 1 file, wrote 1 canvas')
  assert.equal(summarizeActivity(['Canvas'], true), 'Writing 1 canvas')
})

test('a browser run is counted as actions, not as pages', () => {
  // Fourteen calls to drive one page: naming them "pages" would multiply the
  // one page the turn actually looked at by the number of clicks it took.
  assert.equal(summarizeActivity(Array(14).fill('Browser')), '14 browser actions')
  assert.equal(summarizeActivity(['Browser']), '1 browser action')
  // Verb-less, so the present tense is the same noun — the spinner carries the
  // motion, exactly as it does for a search.
  assert.equal(summarizeActivity(['Browser', 'Browser'], true), '2 browser actions')
  // The two browser surfaces are different destinations and keep different
  // nouns, the way Write and Canvas do.
  assert.equal(summarizeActivity(['Browser', 'Preview']), '1 browser action, 1 preview action')
})

test('browsing is method, so what the turn changed still leads', () => {
  assert.equal(
    summarizeActivity(['Browser', 'Browser', 'Edit', 'Read', 'Browser']),
    'Edited 1 file, read 1 file, 3 browser actions'
  )
})

test('an empty run still says something', () => {
  assert.equal(summarizeActivity([]), 'No activity')
  assert.equal(summarizeActivity([], true), 'Working')
})
