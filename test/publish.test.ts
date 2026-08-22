import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultRepoName, sanitizeRepoName } from '../src/renderer/src/lib/publish.ts'

test('sanitizeRepoName coerces typed text into a name GitHub accepts', () => {
  assert.equal(sanitizeRepoName('My Cool App'), 'My-Cool-App')
  // Everything outside GitHub's set collapses to the separator it does allow,
  // without leaving the doubled dashes that collapsing produces.
  assert.equal(sanitizeRepoName('learn/tw (v2)'), 'learn-tw-v2-')
  assert.equal(sanitizeRepoName('a@@@b'), 'a-b')
  // A trailing dash survives on purpose: this runs on every keystroke, and
  // eating it would make `my-app` impossible to type one character at a time.
  assert.equal(sanitizeRepoName('my-'), 'my-')
  // The three characters that are legal beside letters and digits survive.
  assert.equal(sanitizeRepoName('dot.dash-under_score'), 'dot.dash-under_score')
  // A leading dot is a real repository name (`.github`); nothing but dots isn't.
  assert.equal(sanitizeRepoName('.github'), '.github')
  assert.equal(sanitizeRepoName('..'), '')
  assert.equal(sanitizeRepoName('.'), '')
  // GitHub refuses a name ending in .git, so a folder called that isn't a dead end.
  assert.equal(sanitizeRepoName('carbon.git'), 'carbon')
  assert.equal(sanitizeRepoName('  spaced  '), 'spaced')
  assert.equal(sanitizeRepoName(''), '')
  // 100 is GitHub's limit.
  assert.equal(sanitizeRepoName('a'.repeat(120)).length, 100)
})

test('defaultRepoName suggests the folder name', () => {
  assert.equal(defaultRepoName('/Users/me/Projects/learn-tw'), 'learn-tw')
  // A trailing separator still answers with the folder, not an empty string.
  assert.equal(defaultRepoName('/Users/me/Projects/learn tw/'), 'learn-tw')
  assert.equal(defaultRepoName('C:\\code\\my app'), 'my-app')
  // Unlike the as-you-type pass, a suggestion trims what sanitizing left behind.
  assert.equal(defaultRepoName('/Users/me/my app (v2)'), 'my-app-v2')
  assert.equal(defaultRepoName(''), '')
})
