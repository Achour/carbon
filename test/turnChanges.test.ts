import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  changedPathsFromParts,
  groupChanges,
  turnPresentations
} from '../src/renderer/src/lib/turnChanges.ts'

test('extracts and deduplicates Claude and Codex structured edit paths', () => {
  const paths = changedPathsFromParts(
    [
      {
        type: 'tool',
        toolUseId: 'claude-edit',
        name: 'Edit',
        input: { file_path: '/repo/src/app.ts' },
        status: 'success'
      },
      {
        type: 'tool',
        toolUseId: 'codex-change',
        name: 'Edit',
        input: {
          file_path: 'src/app.ts',
          changes: [{ path: 'src/app.ts' }, { path: 'src/new.ts' }]
        },
        status: 'success'
      }
    ],
    '/repo'
  )

  assert.deepEqual(paths, ['src/app.ts', 'src/new.ts'])
})

test('aggregates a multi-message Claude turn into exactly one changes summary', () => {
  const messages = [
    { id: 'user-1', role: 'user' as const, text: 'change it', ts: 1 },
    {
      id: 'assistant-edit-1',
      role: 'assistant' as const,
      ts: 2,
      parts: [
        {
          type: 'tool' as const,
          toolUseId: 'edit-1',
          name: 'Edit',
          input: { file_path: '/repo/src/app.ts' },
          status: 'success' as const
        }
      ]
    },
    {
      id: 'assistant-edit-2',
      role: 'assistant' as const,
      ts: 3,
      parts: [
        {
          type: 'tool' as const,
          toolUseId: 'edit-2',
          name: 'Write',
          input: { file_path: '/repo/src/new.ts' },
          status: 'success' as const
        }
      ]
    },
    {
      id: 'assistant-final',
      role: 'assistant' as const,
      ts: 4,
      parts: [{ type: 'text' as const, text: 'Done.' }]
    }
  ]

  const presentations = turnPresentations(messages, '/repo', false)
  const first = presentations.get('assistant-edit-1')
  const second = presentations.get('assistant-edit-2')
  const final = presentations.get('assistant-final')

  assert.equal(first, final)
  assert.equal(second, final)
  assert.equal(final?.summary?.id, 'assistant-final')
  assert.equal(final?.summary?.parts.length, 3)
  assert.equal(final?.hasChanges, true)
  assert.equal(final?.userMessageId, 'user-1')
})

test('does not expose a partial changes summary while the final turn is busy', () => {
  const messages = [
    { id: 'user-1', role: 'user' as const, text: 'change it', ts: 1 },
    {
      id: 'assistant-edit',
      role: 'assistant' as const,
      ts: 2,
      parts: [
        {
          type: 'tool' as const,
          toolUseId: 'edit',
          name: 'Edit',
          input: { file_path: '/repo/src/app.ts' },
          status: 'running' as const
        }
      ]
    }
  ]

  const presentation = turnPresentations(messages, '/repo', true).get('assistant-edit')
  assert.equal(presentation?.summary, undefined)
  assert.equal(presentation?.hasChanges, false)
})

test('prefers exact Codex file changes over structured tool fallbacks', () => {
  const messages = [
    { id: 'user-1', role: 'user' as const, text: 'change it', ts: 1 },
    {
      id: 'assistant-final',
      role: 'assistant' as const,
      ts: 2,
      parts: [{ type: 'text' as const, text: 'Done.' }],
      fileChanges: [{ path: 'src/app.ts', additions: 4, deletions: 1 }]
    }
  ]

  const presentation = turnPresentations(messages, '/repo', false).get('assistant-final')
  assert.deepEqual(presentation?.summary?.fileChanges, [
    { path: 'src/app.ts', additions: 4, deletions: 1 }
  ])
  assert.equal(presentation?.hasChanges, true)
})

const changed = (path: string, additions = 1, deletions = 0): {
  path: string
  additions: number
  deletions: number
} => ({ path, additions, deletions })

test('groups a directory holding several files and sums its deltas', () => {
  const entries = groupChanges([
    changed('backend/api.ts', 200, 3),
    changed('backend/db.ts', 187, 1),
    changed('web/src/lib/ui.ts', 149, 0)
  ])

  assert.deepEqual(
    entries.map((entry) => (entry.kind === 'group' ? `dir:${entry.dir}` : entry.file.path)),
    ['dir:backend', 'web/src/lib/ui.ts']
  )
  const group = entries[0]
  assert.equal(group.kind === 'group' && group.additions, 387)
  assert.equal(group.kind === 'group' && group.deletions, 4)
  assert.deepEqual(
    group.kind === 'group' ? group.files.map((file) => file.path) : [],
    ['backend/api.ts', 'backend/db.ts']
  )
})

test('a directory with one file stays a plain row, as do files at the root', () => {
  const entries = groupChanges([
    changed('src/only.ts'),
    changed('README.md'),
    changed('.gitignore')
  ])

  assert.deepEqual(
    entries.map((entry) => (entry.kind === 'file' ? entry.file.path : `dir:${entry.dir}`)),
    ['.gitignore', 'README.md', 'src/only.ts']
  )
})
