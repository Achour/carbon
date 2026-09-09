import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  humanizeShellCommand,
  unwrapGrokTool,
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

test('Grok\'s deferred wrapper becomes the tool the renderer already draws', () => {
  assert.deepEqual(
    unwrapGrokTool('use_tool', {
      variant: 'UseTool',
      tool_name: 'claude-in-chrome__navigate',
      tool_input: { url: 'https://example.com' }
    }),
    { name: 'mcp__claude-in-chrome__navigate', input: { url: 'https://example.com' } }
  )
  // Already namespaced: passed through, since `mcp__mcp__…` matches no case.
  assert.deepEqual(unwrapGrokTool('use_tool', { tool_name: 'mcp__preview__stop' }), {
    name: 'mcp__preview__stop',
    input: {}
  })
})

test('only a named wrapper unwraps', () => {
  assert.equal(unwrapGrokTool('Read', { file_path: '/a' }), undefined)
  // A status-only payload carries no name — it must not become `mcp__`.
  assert.equal(unwrapGrokTool('use_tool', { tool_input: { url: 'x' } }), undefined)
  assert.equal(unwrapGrokTool('use_tool', { tool_name: '  ' }), undefined)
})
