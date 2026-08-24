import type {
  Attachment,
  EffortId,
  PermissionModeId,
  Provider,
  ServiceTier,
  WorktreeTarget
} from '@shared/types'

/**
 * Composer drafts — text typed and not sent.
 *
 * The composer used to hold its text in local state, and `App` renders
 * `<ChatView key={chat.id}>`, so *every* chat switch unmounted it and destroyed
 * whatever was in the box. That is the whole bug: it is not specific to the home
 * screen, it has no undo, and it is silent.
 *
 * Two shapes, because they have two lifetimes. A **chat draft** is only what is
 * in the box of a conversation that already exists — the chat itself already
 * remembers its model, effort and permission mode. A **project draft** is a chat
 * that was never created, so it has to carry everything `NewChat` had picked as
 * well, or reopening it would relaunch on settings other than the ones on screen
 * when it was abandoned.
 *
 * A project draft is deliberately *not* a `ChatMeta`. Creating a chat freezes its
 * provider/model pair and, for a `new` worktree target, runs `git worktree add` —
 * a real checkout and branch on disk. A prompt you never sent must not leave
 * either behind, so a draft stays pre-creation state and becomes a chat only at
 * send, where `chats:create` already does that work.
 */
export interface ComposerDraft {
  text: string
  attachments: Attachment[]
}

/** Everything `NewChat` has chosen but not committed. */
export interface ProjectDraftOptions {
  provider: Provider
  model?: string
  effort?: EffortId | ''
  serviceTier?: ServiceTier
  permissionMode?: PermissionModeId
  target?: WorktreeTarget
}

export interface ProjectDraft extends ComposerDraft, ProjectDraftOptions {
  /** Project folder this draft belongs to; one draft per project. */
  cwd: string
  /** Last time the *text* changed — what the sidebar's Drafts section sorts on. */
  updatedAt: number
}

export interface DraftStore {
  chats: Record<string, ComposerDraft>
  projects: Record<string, ProjectDraft>
}

const KEY = 'composerDrafts'

/**
 * Most recent project drafts kept. One per project already bounds this to the
 * number of folders you work in; the cap is only a backstop against a storage
 * key that grows forever.
 */
export const MAX_PROJECT_DRAFTS = 20

export const emptyDraftStore = (): DraftStore => ({ chats: {}, projects: {} })

/** Whitespace is not a draft — it would put an untitled row in the sidebar. */
export function isEmptyDraft(draft: ComposerDraft): boolean {
  return draft.text.trim().length === 0 && draft.attachments.length === 0
}

/**
 * Images and picked elements carry raw base64 in `Attachment.data`, and are the
 * one thing here that runs to megabytes. `localStorage` throws once its ~5 MB
 * quota is gone, and that throw would take the *text* of every other draft with
 * it — so only reference-shaped attachments (a file path, an element ref)
 * survive a restart. Text is the part you cannot cheaply retype; an image you
 * can paste again. Both stay live in memory for the session either way.
 */
export function persistableAttachments(list: Attachment[]): Attachment[] {
  return list.filter((att) => att.data === undefined)
}

/**
 * True when a write would change nothing. The composer flushes on unmount *and*
 * on a debounce, so identical writes are routine — dropping them is what keeps
 * the sidebar from re-rendering on every keystroke tick.
 */
export function sameDraft(a: ComposerDraft | undefined, b: ComposerDraft): boolean {
  if (!a) return isEmptyDraft(b)
  return (
    a.text === b.text &&
    a.attachments.length === b.attachments.length &&
    a.attachments.every((att, i) => att.id === b.attachments[i]?.id)
  )
}

/**
 * Identity of a where-it-runs choice — what change detection compares, and what
 * the branch picker keys its rows on. The branch has to be in it: a typed name
 * lives on the target, so keying on `kind` alone means naming a branch never
 * marks the draft dirty and the name is gone by the next visit.
 *
 * Exhaustive with no `default` arm on purpose. That arm is what let the bug
 * above exist, and it would key the *next* variant's payload away just as
 * quietly; without it a new kind stops compiling here.
 *
 * It lives beside the drafts rather than beside the union in `@shared/types`
 * because `test/drafts.test.ts` loads this module under `node --test`, which
 * resolves no `@shared` alias — so anything this file imports for a *value*
 * would have to be reachable by relative path, and the renderer project doesn't
 * allow `.ts` extensions the way the main one does.
 */
export function worktreeTargetKey(target?: WorktreeTarget): string {
  if (target === undefined) return ''
  switch (target.kind) {
    case 'local':
      return 'local'
    case 'new':
      return `new:${target.branch ?? ''}`
    case 'branch':
      return `branch:${target.branch}`
    case 'existing':
      return `existing:${target.path}`
  }
}

export function sameOptions(a: ProjectDraftOptions, b: ProjectDraftOptions): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.serviceTier === b.serviceTier &&
    a.permissionMode === b.permissionMode &&
    worktreeTargetKey(a.target) === worktreeTargetKey(b.target)
  )
}

/** The Drafts row's label: the first non-empty line, whitespace collapsed. */
export function draftSummary(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/\s+/g, ' ')
    if (trimmed) return trimmed
  }
  return ''
}

/** Project drafts in sidebar order — most recently typed in first. */
export function sortedProjectDrafts(projects: Record<string, ProjectDraft>): ProjectDraft[] {
  return Object.values(projects).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The subset of the live store that is safe and worth writing to disk. */
export function toPersisted(store: DraftStore): DraftStore {
  const chats: Record<string, ComposerDraft> = {}
  for (const [id, draft] of Object.entries(store.chats)) {
    if (isEmptyDraft(draft)) continue
    chats[id] = { text: draft.text, attachments: persistableAttachments(draft.attachments) }
  }
  const projects: Record<string, ProjectDraft> = {}
  for (const draft of sortedProjectDrafts(store.projects)
    .filter((draft) => !isEmptyDraft(draft))
    .slice(0, MAX_PROJECT_DRAFTS)) {
    projects[draft.cwd] = { ...draft, attachments: persistableAttachments(draft.attachments) }
  }
  return { chats, projects }
}

/** Tolerant of any shape: a corrupt key must cost drafts, not the app. */
export function parseDrafts(raw: string | null): DraftStore {
  if (!raw) return emptyDraftStore()
  let parsed: Partial<DraftStore>
  try {
    parsed = JSON.parse(raw) as Partial<DraftStore>
  } catch {
    return emptyDraftStore()
  }
  const out = emptyDraftStore()
  for (const [id, draft] of Object.entries(parsed?.chats ?? {})) {
    if (typeof draft?.text !== 'string') continue
    const next: ComposerDraft = {
      text: draft.text,
      attachments: Array.isArray(draft.attachments) ? draft.attachments : []
    }
    if (!isEmptyDraft(next)) out.chats[id] = next
  }
  for (const [cwd, draft] of Object.entries(parsed?.projects ?? {})) {
    if (typeof draft?.text !== 'string') continue
    const next: ProjectDraft = {
      ...draft,
      cwd,
      text: draft.text,
      attachments: Array.isArray(draft.attachments) ? draft.attachments : [],
      // The pair is reconciled again by `providerForRememberedModel` when the
      // draft is restored; this only keeps the field a valid `Provider`.
      provider:
        draft.provider === 'codex' || draft.provider === 'grok' ? draft.provider : 'claude',
      updatedAt: typeof draft.updatedAt === 'number' ? draft.updatedAt : 0
    }
    if (!isEmptyDraft(next)) out.projects[cwd] = next
  }
  return out
}

/** Drops drafts for chats that no longer exist (deleted in another window). */
export function pruneChatDrafts(
  chats: Record<string, ComposerDraft>,
  liveIds: Iterable<string>
): Record<string, ComposerDraft> {
  const live = new Set(liveIds)
  const out: Record<string, ComposerDraft> = {}
  for (const [id, draft] of Object.entries(chats)) if (live.has(id)) out[id] = draft
  return out
}

export function loadDrafts(): DraftStore {
  try {
    return parseDrafts(localStorage.getItem(KEY))
  } catch {
    return emptyDraftStore()
  }
}

export function saveDrafts(store: DraftStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(toPersisted(store)))
  } catch {
    // Quota, or a storage backend the platform locked down. Drafts stay live in
    // memory for this session, which is the half of the feature that matters —
    // losing them at the next launch beats losing them on the next chat switch.
  }
}
