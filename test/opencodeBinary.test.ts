import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  missingBinaryError,
  parseOpencodeVersion,
  probeOpencode
} from '../src/main/opencodeBinary.ts'

test('a version is picked out of whatever the CLI prints around it', () => {
  assert.equal(parseOpencodeVersion('1.18.15\n'), '1.18.15')
  assert.equal(parseOpencodeVersion('opencode 1.18.15'), '1.18.15')
  assert.equal(parseOpencodeVersion('opencode2 v0.0.0-next-17055'), '0.0.0-next-17055')
  assert.equal(parseOpencodeVersion('no version here'), undefined)
})

test('a missing binary is reported as data, never thrown', async () => {
  // Every failure mode — absent, unreadable, wrong arch, too slow — means the
  // same thing to the caller, and none of them should cross IPC as an exception.
  const probe = await probeOpencode(5000, 'opencode-does-not-exist-carbon-test')
  assert.deepEqual(probe, { installed: false })
})

test('the missing-binary error tells the user how to fix it', () => {
  const message = missingBinaryError().message
  assert.match(message, /install/i)
  assert.match(message, /auth login/)
})
