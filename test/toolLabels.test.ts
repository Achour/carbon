import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  humanizeShellCommand,
  unwrapShellCommand
} from '../src/renderer/src/lib/toolLabels.ts'

const CWD = '/workspace/app'

test('removes the Codex shell transport wrapper', () => {
  assert.equal(unwrapShellCommand(`/bin/zsh -lc "sed -n '1,200p' src/app.ts"`), "sed -n '1,200p' src/app.ts")
})

test('humanizes common inspection commands', () => {
  assert.deepEqual(humanizeShellCommand(`/bin/zsh -lc "sed -n '1,200p' src/app.ts"`, CWD), {
    label: 'Read',
    summary: 'src/app.ts'
  })
  assert.deepEqual(humanizeShellCommand('rg --files -g \'!node_modules\'', CWD), {
    label: 'List files',
    summary: 'app'
  })
})

test('keeps the useful command when no specialized label applies', () => {
  assert.deepEqual(humanizeShellCommand('/bin/zsh -lc "pwd && whoami"', CWD), {
    label: 'Terminal',
    summary: 'pwd && whoami'
  })
})
