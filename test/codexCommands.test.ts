import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODEX_SLASH_COMMANDS,
  codexComposerControl,
  parseCodexGoalCommand,
  parseCodexSlashCommand
} from '../src/shared/codexCommands.ts'

test('publishes only the Codex commands Carbon implements', () => {
  assert.deepEqual(
    CODEX_SLASH_COMMANDS.map((command) => command.name),
    [
      'plan',
      'goal',
      'mcp',
      'review',
      'status',
      'usage'
    ]
  )
})

test('parses the Codex Fast-mode command', () => {
  assert.deepEqual(parseCodexSlashCommand('/fast on'), {
    name: 'fast',
    argument: 'on',
    original: '/fast on'
  })
})

test('keeps composer-owned controls hidden but keyboard accessible', () => {
  assert.equal(codexComposerControl('/model'), 'model')
  assert.equal(codexComposerControl('  /PERMISSIONS  '), 'permissions')
  assert.equal(codexComposerControl('/model terra'), null)
  assert.equal(codexComposerControl('/fast'), null)

  assert.deepEqual(parseCodexSlashCommand('/model terra'), {
    name: 'model',
    argument: 'terra',
    original: '/model terra'
  })
  assert.deepEqual(parseCodexSlashCommand('/permissions auto'), {
    name: 'permissions',
    argument: 'auto',
    original: '/permissions auto'
  })
})

test('keeps the hidden reasoning command for CLI keyboard compatibility', () => {
  assert.deepEqual(parseCodexSlashCommand('/reasoning xhigh'), {
    name: 'reasoning',
    argument: 'xhigh',
    original: '/reasoning xhigh'
  })
})

test('parses a supported command and keeps its multiline argument', () => {
  assert.deepEqual(parseCodexSlashCommand('/plan first step\nsecond step'), {
    name: 'plan',
    argument: 'first step\nsecond step',
    original: '/plan first step\nsecond step'
  })
})

test('parses the native Codex goal lifecycle', () => {
  assert.deepEqual(parseCodexSlashCommand('/goal edit Finish the migration'), {
    name: 'goal',
    argument: 'edit Finish the migration',
    original: '/goal edit Finish the migration'
  })
})

test('parses goal actions without swallowing objective prose', () => {
  assert.deepEqual(parseCodexGoalCommand(''), { action: 'view' })
  assert.deepEqual(parseCodexGoalCommand('pause'), { action: 'status', status: 'paused' })
  assert.deepEqual(parseCodexGoalCommand('resume'), { action: 'status', status: 'active' })
  assert.deepEqual(parseCodexGoalCommand('clear'), { action: 'clear' })
  assert.deepEqual(parseCodexGoalCommand('edit Keep tests green'), {
    action: 'set',
    objective: 'Keep tests green'
  })
  assert.deepEqual(parseCodexGoalCommand('clear the migration blockers'), {
    action: 'set',
    objective: 'clear the migration blockers'
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
