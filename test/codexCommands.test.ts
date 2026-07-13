import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODEX_SLASH_COMMANDS,
  parseCodexSlashCommand
} from '../src/shared/codexCommands.ts'

test('publishes only the Codex commands Karbun implements', () => {
  assert.deepEqual(
    CODEX_SLASH_COMMANDS.map((command) => command.name),
    ['plan', 'model', 'reasoning', 'permissions', 'status', 'init', 'review']
  )
})

test('parses a supported command and keeps its multiline argument', () => {
  assert.deepEqual(parseCodexSlashCommand('/plan first step\nsecond step'), {
    name: 'plan',
    argument: 'first step\nsecond step',
    original: '/plan first step\nsecond step'
  })
})

test('command names are case-insensitive', () => {
  assert.deepEqual(parseCodexSlashCommand('  /STATUS  '), {
    name: 'status',
    argument: '',
    original: '/STATUS'
  })
})

test('unknown and embedded slash text remains a normal prompt', () => {
  assert.equal(parseCodexSlashCommand('/fork'), null)
  assert.equal(parseCodexSlashCommand('please run /status'), null)
})
