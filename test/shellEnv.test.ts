import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { mergePaths, parseShellPath } from '../src/main/shellEnv.ts'

test('mergePaths preserves precedence and removes duplicate entries', () => {
  assert.equal(
    mergePaths(
      ['/Users/me/.local/bin', '/usr/local/bin'].join(delimiter),
      ['/usr/local/bin', '/usr/bin'].join(delimiter)
    ),
    ['/Users/me/.local/bin', '/usr/local/bin', '/usr/bin'].join(delimiter)
  )
})

test('parseShellPath ignores shell startup noise before the environment marker', () => {
  const output = Buffer.from(
    `oh-my-zsh startup output\n\0KARBUN_ENV_START\0HOME=/Users/me\0PATH=/custom/bin:/usr/bin\0SHELL=/bin/zsh\0`
  )
  assert.equal(parseShellPath(output), '/custom/bin:/usr/bin')
})

test('parseShellPath rejects output without the marker', () => {
  assert.equal(parseShellPath(Buffer.from('PATH=/untrusted')), undefined)
})
