import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PROJECT_DRAFTS,
  draftSummary,
  isEmptyDraft,
  parseDrafts,
  persistableAttachments,
  pruneChatDrafts,
  sameDraft,
  sameOptions,
  sortedProjectDrafts,
  toPersisted
} from '../src/renderer/src/lib/drafts.ts'
import type { ComposerDraft, DraftStore, ProjectDraft } from '../src/renderer/src/lib/drafts.ts'
import type { Attachment } from '../src/shared/types.ts'

const file = (id: string): Attachment => ({ id, kind: 'file', name: id, path: `/tmp/${id}` })
const image = (id: string): Attachment => ({
  id,
  kind: 'image',
  name: id,
  mediaType: 'image/png',
  data: 'AAAA'
})

const chat = (text: string, attachments: Attachment[] = []): ComposerDraft => ({ text, attachments })

const project = (cwd: string, text: string, updatedAt: number): ProjectDraft => ({
  cwd,
  text,
  attachments: [],
  provider: 'claude',
  updatedAt
})

test('whitespace is not a draft, an attachment is', () => {
  assert.equal(isEmptyDraft(chat('')), true)
  assert.equal(isEmptyDraft(chat('   \n\t ')), true)
  assert.equal(isEmptyDraft(chat('hi')), false)
  // Text-free but worth keeping — the row says "Attachment".
  assert.equal(isEmptyDraft(chat('', [file('a')])), false)
})

test('only reference-shaped attachments are persisted', () => {
  // Base64 payloads are the one thing here that can blow the localStorage quota,
  // and that throw would take every draft's *text* with it.
  assert.deepEqual(persistableAttachments([file('a'), image('b'), file('c')]), [
    file('a'),
    file('c')
  ])
})

test('toPersisted drops empties and strips attachment payloads', () => {
  const store: DraftStore = {
    chats: { a: chat('keep', [image('i'), file('f')]), b: chat('  ') },
    projects: { '/p': { ...project('/p', 'hello', 5), attachments: [image('i')] } }
  }
  const out = toPersisted(store)
  assert.deepEqual(Object.keys(out.chats), ['a'])
  assert.deepEqual(out.chats.a.attachments, [file('f')])
  assert.deepEqual(out.projects['/p'].attachments, [])
  assert.equal(out.projects['/p'].text, 'hello')
})

test('toPersisted keeps the most recent project drafts up to the cap', () => {
  const projects: Record<string, ProjectDraft> = {}
  // Oldest first, so a cap that sliced the wrong end would be visible.
  for (let i = 0; i < MAX_PROJECT_DRAFTS + 5; i++) projects[`/p${i}`] = project(`/p${i}`, 'x', i)
  const kept = Object.keys(toPersisted({ chats: {}, projects }).projects)
  assert.equal(kept.length, MAX_PROJECT_DRAFTS)
  assert.equal(kept.includes('/p4'), false)
  assert.equal(kept.includes(`/p${MAX_PROJECT_DRAFTS + 4}`), true)
})

test('project drafts sort most-recently-typed first', () => {
  const projects = {
    '/a': project('/a', 'a', 10),
    '/b': project('/b', 'b', 30),
    '/c': project('/c', 'c', 20)
  }
  assert.deepEqual(
    sortedProjectDrafts(projects).map((d) => d.cwd),
    ['/b', '/c', '/a']
  )
})

test('parseDrafts survives anything in the storage key', () => {
  assert.deepEqual(parseDrafts(null), { chats: {}, projects: {} })
  assert.deepEqual(parseDrafts('not json'), { chats: {}, projects: {} })
  assert.deepEqual(parseDrafts('null'), { chats: {}, projects: {} })
  // Wrong-shaped entries are skipped one by one rather than failing the load.
  const out = parseDrafts(
    JSON.stringify({
      chats: { good: { text: 'hi' }, bad: { text: 7 }, blank: { text: '  ' } },
      projects: { '/p': { text: 'yo', provider: 'nonsense', updatedAt: 'soon' } }
    })
  )
  assert.deepEqual(Object.keys(out.chats), ['good'])
  assert.deepEqual(out.chats.good.attachments, [])
  assert.equal(out.projects['/p'].provider, 'claude')
  assert.equal(out.projects['/p'].updatedAt, 0)
  assert.equal(out.projects['/p'].cwd, '/p')
})

test('parseDrafts round-trips what toPersisted wrote', () => {
  const store: DraftStore = {
    chats: { a: chat('one', [file('f')]) },
    projects: {
      '/p': {
        ...project('/p', 'two', 99),
        provider: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        permissionMode: 'default',
        target: { kind: 'existing', path: '/w', branch: 'b', repoRoot: '/r' }
      }
    }
  }
  const out = parseDrafts(JSON.stringify(toPersisted(store)))
  assert.deepEqual(out, store)
})

test('sameDraft ignores no-op writes but catches real edits', () => {
  // The composer flushes on unmount as well as on a debounce, so identical
  // writes are routine; treating them as changes re-renders the sidebar.
  assert.equal(sameDraft(chat('hi', [file('f')]), chat('hi', [file('f')])), true)
  assert.equal(sameDraft(chat('hi'), chat('hi!')), false)
  assert.equal(sameDraft(chat('hi'), chat('hi', [file('f')])), false)
  assert.equal(sameDraft(chat('hi', [file('a')]), chat('hi', [file('b')])), false)
  // No stored draft and nothing typed is not a change either.
  assert.equal(sameDraft(undefined, chat('')), true)
  assert.equal(sameDraft(undefined, chat('hi')), false)
})

test('sameOptions compares a worktree target by identity, not object', () => {
  const base = { provider: 'claude' as const, model: 'opus' }
  assert.equal(sameOptions(base, { ...base }), true)
  assert.equal(sameOptions(base, { ...base, model: 'sonnet' }), false)
  assert.equal(sameOptions(base, { ...base, effort: 'high' }), false)
  const target = { kind: 'existing' as const, path: '/w', branch: 'b', repoRoot: '/r' }
  assert.equal(sameOptions({ ...base, target }, { ...base, target: { ...target } }), true)
  assert.equal(
    sameOptions({ ...base, target }, { ...base, target: { ...target, path: '/other' } }),
    false
  )
  assert.equal(sameOptions({ ...base, target }, { ...base, target: { kind: 'local' } }), false)
  assert.equal(sameOptions(base, { ...base, target: { kind: 'local' } }), false)
})

test('draftSummary quotes the first line that has anything on it', () => {
  assert.equal(draftSummary('hello'), 'hello')
  assert.equal(draftSummary('\n\n  second line  \nthird'), 'second line')
  assert.equal(draftSummary('a\t\tb   c'), 'a b c')
  assert.equal(draftSummary('   '), '')
})

test('pruneChatDrafts drops drafts whose chat is gone', () => {
  const chats = { a: chat('a'), b: chat('b') }
  assert.deepEqual(Object.keys(pruneChatDrafts(chats, ['a'])), ['a'])
  assert.deepEqual(Object.keys(pruneChatDrafts(chats, ['a', 'b', 'c'])), ['a', 'b'])
  assert.deepEqual(pruneChatDrafts(chats, []), {})
})
