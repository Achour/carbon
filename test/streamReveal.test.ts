import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DRAIN_MS, nextReveal, revealLimit } from '../src/renderer/src/lib/streamReveal.ts'

test('holds back the word still arriving', () => {
  // "the qui" — `qui` may become `quick`, and revealing it now is what puts a
  // half-written word (or half a `**bold**` delimiter) on screen.
  assert.equal(revealLimit('the qui', true), 4)
  assert.equal('the qui'.slice(0, revealLimit('the qui', true)), 'the ')
})

test('a completed word is revealed as soon as its delimiter lands', () => {
  assert.equal(revealLimit('the quick ', true), 10)
})

test('every kind of whitespace ends a word', () => {
  assert.equal(revealLimit('a\nb', true), 2)
  assert.equal(revealLimit('a\tb', true), 2)
})

test('an idle stream reveals the trailing word', () => {
  // Replies end in "." far more often than in a space, so holding for a
  // delimiter that is never coming would leave the last word off the screen.
  assert.equal(revealLimit('all done.', false), 9)
  assert.equal(revealLimit('all done.', true), 4)
})

test('a run with no delimiter in sight is not held forever', () => {
  const uri = 'x '.concat('a'.repeat(500))
  assert.equal(revealLimit(uri, true), uri.length)
})

test('nothing to reveal is a no-op', () => {
  assert.equal(nextReveal('abc', 3, 3, 16), 3)
  assert.equal(nextReveal('abc def ', 8, 8, 16), 8)
})

test('a step never stops mid-word', () => {
  const text = 'alpha beta gamma delta '
  // One frame's share of a 23-char backlog is ~2 characters, which lands inside
  // "alpha"; it has to run on to the space after it.
  const next = nextReveal(text, 0, text.length, 16)
  assert.equal(text.slice(0, next), 'alpha ')
})

test('most of the backlog is gone within DRAIN_MS, and all of it terminates', () => {
  const words = 'word '.repeat(60)
  let shown = 0
  let elapsed = 0
  let atOneConstant = -1
  while (shown < words.length && elapsed < 5000) {
    shown = nextReveal(words, shown, words.length, 16)
    elapsed += 16
    if (atOneConstant < 0 && elapsed >= DRAIN_MS) atOneConstant = shown
  }
  // Exponential catch-up: ~63% after one time constant. The floor and the word
  // snapping push it a little past that, which is the point — they are what stop
  // the tail halving forever.
  assert.ok(atOneConstant / words.length > 0.6, `${atOneConstant}/${words.length} after DRAIN_MS`)
  assert.equal(shown, words.length)
  assert.ok(elapsed < 3 * DRAIN_MS, `finished in ${elapsed}ms`)
})

test('a bigger backlog moves faster, so latency does not grow with it', () => {
  const text = 'word '.repeat(200)
  const small = nextReveal(text, text.length - 25, text.length, 16)
  const large = nextReveal(text, 0, text.length, 16)
  assert.ok(large - 0 > small - (text.length - 25))
})

test('a long frame reveals more, and never more than the limit', () => {
  const text = 'word '.repeat(20)
  assert.ok(nextReveal(text, 0, text.length, 60) > nextReveal(text, 0, text.length, 16))
  assert.equal(nextReveal(text, 0, text.length, 10_000), text.length)
})

test('every frame makes progress', () => {
  // A share that rounds to zero would stall the drain silently.
  const text = 'a b '
  assert.ok(nextReveal(text, 0, text.length, 0) > 0)
})
