import { randomUUID } from 'node:crypto'
import { readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Codex,
  type Input,
  type ModelReasoningEffort,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type UserInput,
  type Usage
} from '@openai/codex-sdk'
import { CODEX_DEFAULT_MODEL, MODEL_OPTIONS } from '@shared/types'
import type {
  AccountInfo,
  AgentInfo,
  AssistantMessage,
  AssistantPart,
  Attachment,
  ChatData,
  ChatStatus,
  EffortId,
  ElementRef,
  McpServerInfo,
  ModelOption,
  OpResult,
  PermissionDecision,
  PermissionModeId,
  RewindResult,
  ToolStatus,
  TurnStats,
  UsageInfo
} from '@shared/types'
import type { Store } from './store'
import type { AgentSession, Emit } from './session'
import { IMAGE_EXT, pickTurnImages } from './imageScan'
import { isMissingCodexThreadError } from './codexResume'
import { parseCodexPlan, promptForCodexMode } from './codexMode'
import {
  captureWorkspaceTree,
  rewindWorkspaceCheckpoint,
  summarizeWorkspaceCheckpoint,
  type WorkspaceCheckpoint
} from './workspaceCheckpoint'

const OUTPUT_CAP = 100_000

// Fallback context window when the selected Codex model isn't in MODEL_OPTIONS
// (per-model windows live there). The gpt-5.6 family is 1,050,000 tokens.
const CODEX_CONTEXT_WINDOW = 1_050_000

interface PendingTurn {
  input: Input
  temps: string[]
  userMessageId: string
}

/**
 * Karbun's permission modes map onto Codex's sandbox policy. The Codex SDK runs
 * `codex exec` non-interactively — it exposes no per-tool approval callback (see
 * ThreadEvent, which has no approval event) — so we pick a sandbox up front
 * rather than prompting mid-turn, and always run with `approvalPolicy: 'never'`.
 * Plan mode also gets a collaboration instruction in buildInput(); read-only is
 * the enforcement layer, not the entirety of its behavior.
 */
function sandboxForMode(mode: PermissionModeId): SandboxMode {
  switch (mode) {
    case 'plan':
      return 'read-only'
    case 'bypassPermissions':
      return 'danger-full-access'
    default:
      // default | acceptEdits | auto — Codex may edit within the workspace.
      return 'workspace-write'
  }
}

/**
 * Codex reasoning tops out at 'xhigh'. '' (app default) defers to ~/.codex config.
 * 'max' is a Claude-only tier the composer never offers for Codex — a chat can
 * only carry it as leftover inherited state, and the composer displays that as
 * "Default", so map it to undefined here too. Mapping it to 'xhigh' instead would
 * silently send X-High while the UI reads "Default".
 */
function effortForCodex(effort?: EffortId): ModelReasoningEffort | undefined {
  switch (effort) {
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'xhigh':
      return 'xhigh'
    default:
      return undefined
  }
}

function cmdStatus(status: string): ToolStatus {
  return status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'running'
}

function cap(text: string): string {
  return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n… (truncated)` : text
}


const TEMP_PREFIX = 'karbun-codex-'

/** Materializes a base64 image to a temp file (Codex takes images by path). */
function writeTempImage(mediaType: string, base64: string): string | null {
  try {
    const ext = mediaType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
    const path = join(tmpdir(), `${TEMP_PREFIX}${randomUUID()}.${ext}`)
    writeFileSync(path, Buffer.from(base64, 'base64'))
    return path
  } catch (err) {
    console.error('writeTempImage failed:', err)
    return null
  }
}

let staleCleaned = false
/** One-time sweep of temp attachment copies left behind by an abnormal exit. */
function cleanupStaleTempFiles(): void {
  if (staleCleaned) return
  staleCleaned = true
  const cutoff = Date.now() - 60 * 60 * 1000
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(TEMP_PREFIX)) continue
      const p = join(tmpdir(), name)
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true })
      } catch {
        // ignore individual failures
      }
    }
  } catch {
    // tmpdir unreadable — nothing to clean
  }
}

/** Renders a picked UI element as a text block the agent can act on. */
function describeElement(el: ElementRef): string {
  const lines = [`Selected UI element from the running app (${el.url}):`]
  if (el.source?.file) {
    const col = el.source.column != null ? `:${el.source.column}` : ''
    const loc = el.source.line != null ? `${el.source.file}:${el.source.line}${col}` : el.source.file
    lines.push(`- Source: ${loc}`)
  }
  if (el.label) lines.push(`- Text: ${JSON.stringify(el.label)}`)
  if (el.selector) lines.push(`- Selector: ${el.selector}`)
  if (el.html) lines.push(`- HTML: ${el.html}`)
  return lines.join('\n')
}

/**
 * One Codex conversation for a chat. Unlike `ClaudeSession` (a single long-lived
 * SDK process fed by an input queue), the Codex SDK models a `Thread` whose
 * `runStreamed()` is one turn; consecutive turns reuse the same thread, and the
 * thread id (captured from `thread.started`) resumes the conversation across app
 * restarts via `resumeThread`. Each turn's item stream is normalized into the
 * same `AssistantPart[]` / `ChatEvent`s the renderer already understands, so
 * nothing downstream of `ChatEvent` knows or cares that this is Codex.
 */
export class CodexSession implements AgentSession {
  private codex = new Codex() // reuses the user's ~/.codex (ChatGPT) login
  private thread: Thread | null = null
  private threadId: string | null
  // Rebuild the thread before the next turn — thread options (model, sandbox,
  // effort) are fixed at start/resume time and have no live setter.
  private optionsDirty = true
  private pending: PendingTurn[] = []
  private checkpoints = new Map<string, WorkspaceCheckpoint>()
  private activeUserMessageId: string | null = null
  private running = false
  private abort: AbortController | null = null
  private current: AssistantMessage | null = null
  // Codex item ids (item_0, item_1, …) restart every turn, so this map — item id
  // → part location in the current assistant message — is cleared per turn.
  private itemLoc = new Map<string, { message: AssistantMessage; index: number }>()
  private turnStart = 0
  // Snapshot of this thread's raw generated-image files at turn start. Built-in
  // image_gen calls are not represented in the Codex SDK ThreadItem stream, so
  // the before/after diff is the reliable fallback when the final message is
  // empty and no shell command mentions the saved path.
  private generatedBeforeTurn = new Map<string, number>()
  /** Synthetic ExitPlanMode request used to reuse Karbun's plan-review UI. */
  private planReview: { requestId: string; plan: string; userMessageId: string } | null = null
  private interrupted = false
  private lastEmittedStatus: ChatStatus | null = null
  dead = false
  private disposed = false

  constructor(
    private chat: ChatData,
    private emit: Emit,
    private store: Store,
    // Kept for signature symmetry with ClaudeSession; a Codex session is warm
    // (no per-turn process to outlive it), so it never dies on its own.
    private onDead: () => void
  ) {
    this.threadId = chat.sessionId ?? null
    void this.onDead
    cleanupStaleTempFiles()
  }

  // ---------- Emitting helpers ----------

  private setStatus(status: ChatStatus): void {
    if (status === this.lastEmittedStatus) return
    this.lastEmittedStatus = status
    this.emit({ type: 'status', chatId: this.chat.id, status })
  }

  private pushMessage(message: ChatData['messages'][number]): void {
    this.chat.messages.push(message)
    this.chat.updatedAt = Date.now()
    this.emit({ type: 'message', chatId: this.chat.id, message })
    this.store.saveChatSoon(this.chat.id)
  }

  private pushError(text: string): void {
    this.pushMessage({ id: randomUUID(), role: 'event', kind: 'error', text, ts: Date.now() })
  }

  private ensureCurrent(): AssistantMessage {
    if (!this.current) {
      this.current = { id: randomUUID(), role: 'assistant', parts: [], ts: Date.now() }
      this.chat.messages.push(this.current)
      this.chat.updatedAt = Date.now()
      this.emit({ type: 'message', chatId: this.chat.id, message: this.current })
    }
    return this.current
  }

  private emitPart(message: AssistantMessage, index: number): void {
    this.emit({
      type: 'part',
      chatId: this.chat.id,
      messageId: message.id,
      partIndex: index,
      part: message.parts[index]
    })
    this.store.saveChatSoon(this.chat.id)
  }

  // ---------- Sending ----------

  send(text: string, attachments: Attachment[] = []): void {
    if (this.disposed) return
    if (!this.chat.title) {
      const title = text || attachments.map((a) => a.name).join(', ')
      this.chat.title = title.replace(/\s+/g, ' ').trim().slice(0, 64)
      this.emit({ type: 'meta', chatId: this.chat.id, patch: { title: this.chat.title } })
    }
    const messageId = randomUUID()
    this.pushMessage({
      id: messageId,
      role: 'user',
      text,
      ts: Date.now(),
      ...(attachments.length ? { attachments } : {})
    })
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { updatedAt: this.chat.updatedAt } })
    this.pending.push({ ...this.buildInput(text, attachments), userMessageId: messageId })
    void this.drain()
  }

  private buildInput(text: string, attachments: Attachment[]): { input: Input; temps: string[] } {
    const images: UserInput[] = []
    const temps: string[] = []
    const filePaths: string[] = []
    const elementNotes: string[] = []
    for (const a of attachments) {
      if ((a.kind === 'image' || a.kind === 'element') && a.data && a.mediaType) {
        // Codex takes images by file path, so materialize base64 blobs to temp
        // files (Karbun's dropped/pasted images have no path of their own). The
        // copy is deleted once the turn that consumes it finishes (see runTurn).
        const path = writeTempImage(a.mediaType, a.data)
        if (path) {
          images.push({ type: 'local_image', path })
          temps.push(path)
        }
      }
      if (a.kind === 'element' && a.element) elementNotes.push(describeElement(a.element))
      if (a.kind === 'file' && a.path) filePaths.push(a.path)
    }
    let prompt = text
    if (filePaths.length) {
      prompt = `${prompt ? `${prompt}\n\n` : ''}Attached files:\n${filePaths
        .map((p) => `- ${p}`)
        .join('\n')}`
    }
    if (elementNotes.length) {
      prompt = `${prompt ? `${prompt}\n\n` : ''}${elementNotes.join('\n\n')}`
    }
    // The SDK exposes sandbox selection but not the interactive Codex client's
    // Plan/Default collaboration-mode switch. Keep this provider-only and hidden
    // from the rendered transcript while supplying equivalent turn semantics.
    prompt = promptForCodexMode(prompt, this.chat.permissionMode === 'plan')
    const blocks: UserInput[] = [{ type: 'text', text: prompt }, ...images]
    return { input: blocks, temps }
  }

  // ---------- Turn loop ----------

  private contextWindow(): number {
    return (
      MODEL_OPTIONS.find((m) => m.id === this.chat.model)?.contextWindow ?? CODEX_CONTEXT_WINDOW
    )
  }

  private threadOptions(): ThreadOptions {
    // 'codex-default' means "no model override" — let the Codex config pick.
    const model = this.chat.model && this.chat.model !== CODEX_DEFAULT_MODEL ? this.chat.model : undefined
    return {
      model,
      workingDirectory: this.chat.cwd,
      // Karbun opens arbitrary folders (not always git repos); don't block on it.
      skipGitRepoCheck: true,
      sandboxMode: sandboxForMode(this.chat.permissionMode),
      approvalPolicy: 'never',
      modelReasoningEffort: effortForCodex(this.chat.effort)
    }
  }

  private ensureThread(): Thread {
    if (this.thread && !this.optionsDirty) return this.thread
    const opts = this.threadOptions()
    this.thread = this.threadId
      ? this.codex.resumeThread(this.threadId, opts)
      : this.codex.startThread(opts)
    this.optionsDirty = false
    return this.thread
  }

  private generatedImagesRoot(): string {
    const home = homedir()
    return join(process.env.CODEX_HOME || join(home, '.codex'), 'generated_images')
  }

  /** Current image files for this Codex thread, keyed by canonical path + mtime. */
  private threadGeneratedImages(): Map<string, number> {
    const images = new Map<string, number>()
    if (!this.threadId) return images
    const dir = join(this.generatedImagesRoot(), this.threadId)
    try {
      for (const name of readdirSync(dir)) {
        if (!IMAGE_EXT.test(name)) continue
        const path = join(dir, name)
        try {
          const st = statSync(path)
          if (st.isFile()) images.set(realpathSync(path), st.mtimeMs)
        } catch {
          // A file can disappear between readdir and stat; skip it.
        }
      }
    } catch {
      // The directory does not exist until this thread generates its first image.
    }
    return images
  }

  private generatedImagesThisTurn(): string[] {
    const current = this.threadGeneratedImages()
    const fresh: string[] = []
    for (const [path, mtimeMs] of current) {
      const before = this.generatedBeforeTurn.get(path)
      if (before == null || mtimeMs > before) fresh.push(path)
    }
    return fresh
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true
    try {
      while (this.pending.length && !this.disposed) {
        await this.runTurn(this.pending.shift()!)
      }
    } finally {
      this.running = false
    }
    if (this.disposed) return
    // A send() that arrived while the loop was tearing down couldn't start a new
    // drain (running was still true) — pick it up now so no turn is dropped.
    if (this.pending.length) {
      void this.drain()
    } else if (!this.planReview) {
      this.setStatus('idle')
      this.store.saveChat(this.chat.id)
    }
  }

  private async runTurn(turn: PendingTurn): Promise<void> {
    const before = await captureWorkspaceTree(this.chat.cwd)
    this.abort = new AbortController()
    this.interrupted = false
    this.turnStart = Date.now()
    this.generatedBeforeTurn = this.threadGeneratedImages()
    this.current = null
    this.activeUserMessageId = turn.userMessageId
    this.itemLoc.clear()
    // 'starting' until the thread has an id (first turn / cold resume), matching
    // how a fresh Claude session reads before its init.
    this.setStatus(this.threadId ? 'streaming' : 'starting')
    try {
      let retriedMissingThread = false
      while (!this.disposed) {
        const resumedThreadId = this.threadId
        const thread = this.ensureThread()
        try {
          const { events } = await thread.runStreamed(turn.input, { signal: this.abort.signal })
          for await (const event of events) {
            if (this.disposed) break
            this.handleEvent(event)
          }
          break
        } catch (err) {
          // Karbun persists the Codex thread id, while the corresponding rollout
          // lives separately under ~/.codex/sessions. If that file was cleaned or
          // moved, retry this same prompt once in a fresh thread rather than
          // permanently poisoning the chat with an unusable resume id.
          if (
            !retriedMissingThread &&
            resumedThreadId &&
            !this.disposed &&
            !this.interrupted &&
            isMissingCodexThreadError(err)
          ) {
            retriedMissingThread = true
            this.recoverFromMissingThread()
            continue
          }
          if (!this.disposed && !this.interrupted) {
            this.pushError(err instanceof Error ? err.message : String(err))
          }
          break
        }
      }
    } finally {
      // Event handlers called above populate `current`; TS cannot see mutation
      // through those method calls, so retain the runtime value explicitly.
      const completedMessage = this.current as AssistantMessage | null
      this.terminalizeRunning()
      this.current = null
      this.activeUserMessageId = null
      this.itemLoc.clear()
      this.abort = null
      // The SDK consumed any temp attachment copies at turn start — drop them now
      // rather than holding them for the session's lifetime.
      for (const f of turn.temps) {
        try {
          rmSync(f, { force: true })
        } catch {
          // best-effort cleanup
        }
      }
      if (before) {
        const after = await captureWorkspaceTree(this.chat.cwd)
        if (after && after.root === before.root) {
          const checkpoint = { before, after }
          this.checkpoints.set(turn.userMessageId, checkpoint)
          if (completedMessage) {
            const fileChanges = await summarizeWorkspaceCheckpoint(checkpoint)
            completedMessage.fileChanges = fileChanges
            this.emit({ type: 'message', chatId: this.chat.id, message: completedMessage })
            this.store.saveChatSoon(this.chat.id)
          }
        }
      }
    }
  }

  /** Clear only an unusable Codex resume id; transcript and current prompt stay. */
  private recoverFromMissingThread(): void {
    this.thread = null
    this.threadId = null
    this.optionsDirty = true
    this.generatedBeforeTurn.clear()
    this.chat.sessionId = undefined
    this.chat.contextTokens = undefined
    this.emit({
      type: 'meta',
      chatId: this.chat.id,
      patch: { sessionId: undefined, contextTokens: undefined }
    })
    this.pushMessage({
      id: randomUUID(),
      role: 'event',
      kind: 'info',
      text: 'The saved Codex thread was unavailable, so Karbun started a fresh Codex session.',
      ts: Date.now()
    })
    this.setStatus('starting')
    this.store.saveChat(this.chat.id)
  }

  private handleEvent(event: ThreadEvent): void {
    switch (event.type) {
      case 'thread.started':
        this.threadId = event.thread_id
        // First turns do not have an id when runTurn starts. thread.started is
        // emitted before tools run, so take their empty/pre-existing baseline now.
        this.generatedBeforeTurn = this.threadGeneratedImages()
        if (event.thread_id && event.thread_id !== this.chat.sessionId) {
          this.chat.sessionId = event.thread_id
          this.emit({ type: 'meta', chatId: this.chat.id, patch: { sessionId: event.thread_id } })
          this.store.saveChatSoon(this.chat.id)
        }
        break
      case 'item.started':
      case 'item.updated':
        this.upsertItem(event.item, false)
        break
      case 'item.completed':
        this.upsertItem(event.item, true)
        break
      case 'turn.started':
        break
      case 'turn.completed':
        this.onTurnCompleted(event.usage)
        break
      case 'turn.failed':
        if (!this.disposed && !this.interrupted) {
          this.pushError(event.error?.message ?? 'The turn failed.')
        }
        break
      case 'error':
        if (!this.disposed && !this.interrupted) this.pushError(event.message ?? 'Codex error.')
        break
      default:
        // turn.started and any future events need no handling here.
        break
    }
  }

  /**
   * Codex's image-gen skill saves the picture to a file and only *sometimes*
   * reports its path as a markdown link (effort-dependent) — so keying off the
   * final message misses images. At turn end, scan the turn's tool output/text
   * plus the before/after diff of its generated-images directory, then render any
   * files not already shown inline.
   */
  private surfaceTurnImages(): void {
    const message = this.current
    const textParts: string[] = []
    const commands: string[] = []
    const changes: string[] = []
    for (const part of message?.parts ?? []) {
      if (!part) continue
      if (part.type === 'text') textParts.push(part.text)
      else if (part.type === 'tool') {
        if (part.output) commands.push(part.output)
        const input = part.input as Record<string, unknown> | null
        if (input && typeof input.command === 'string') commands.push(input.command)
        if (Array.isArray(input?.changes)) {
          for (const ch of input!.changes as Array<{ path?: unknown }>) {
            if (typeof ch?.path === 'string') changes.push(ch.path)
          }
        }
      }
    }
    const home = homedir()
    const show = pickTurnImages(
      {
        text: textParts.join('\n'),
        commands,
        changes,
        generated: this.generatedImagesThisTurn()
      },
      {
        cwd: this.chat.cwd,
        home,
        genDir: this.generatedImagesRoot(),
        turnStart: this.turnStart,
        stat: (abs) => {
          try {
            const st = statSync(abs)
            if (!st.isFile()) return null
            return { isFile: true, mtimeMs: st.mtimeMs, real: realpathSync(abs) }
          } catch {
            return null
          }
        }
      }
    )
    if (!show.length) return
    // image_gen may be the only item in the turn and the SDK may provide no
    // agent_message at all. Create the assistant message only once we know there
    // is an image to attach, avoiding an empty bubble for ordinary silent turns.
    const target = message ?? this.ensureCurrent()
    const index = target.parts.length
    target.parts[index] = {
      type: 'text',
      text: show.map((p) => `![generated image](${p})`).join('\n\n')
    }
    this.emitPart(target, index)
  }

  private onTurnCompleted(usage: Usage | null): void {
    this.surfaceTurnImages()
    // input_tokens is the full prompt of the completed turn — i.e. what now
    // occupies the context window.
    const total = usage?.input_tokens ?? 0
    if (total > 0 && total !== this.chat.contextTokens) {
      this.chat.contextTokens = total
      this.emit({ type: 'meta', chatId: this.chat.id, patch: { contextTokens: total } })
    }
    const window = this.contextWindow()
    if (this.chat.contextWindow !== window) {
      this.chat.contextWindow = window
      this.emit({ type: 'meta', chatId: this.chat.id, patch: { contextWindow: window } })
    }
    const stats: TurnStats = {
      // ChatGPT-subscription usage has no per-turn dollar cost to report.
      costUsd: 0,
      durationMs: Date.now() - this.turnStart,
      numTurns: 1,
      model: this.chat.model || 'Codex',
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens
    }
    this.pushMessage({ id: randomUUID(), role: 'event', kind: 'turn', text: '', ts: Date.now(), stats })
    this.chat.updatedAt = Date.now()
    this.store.saveChat(this.chat.id)
    this.offerPlanForReview()
  }

  /** Turn a completed Codex planning response into the same review event Claude uses. */
  private offerPlanForReview(): void {
    if (this.chat.permissionMode !== 'plan' || this.planReview || this.interrupted) return
    const message = this.current
    if (!message) return
    for (let index = message.parts.length - 1; index >= 0; index--) {
      const part = message.parts[index]
      if (!part || part.type !== 'text') continue
      const parsed = parseCodexPlan(part.text)
      if (!parsed) continue
      if (parsed.displayText !== part.text) {
        message.parts[index] = { ...part, text: parsed.displayText }
        this.emitPart(message, index)
      }
      const requestId = randomUUID()
      this.planReview = {
        requestId,
        plan: parsed.plan,
        userMessageId: this.activeUserMessageId ?? ''
      }
      this.emit({
        type: 'permission-request',
        chatId: this.chat.id,
        request: {
          id: requestId,
          chatId: this.chat.id,
          toolUseId: `codex-plan-${requestId}`,
          toolName: 'ExitPlanMode',
          input: { plan: parsed.plan },
          title: 'Review plan',
          displayName: 'Codex plan',
          description: 'Approve this plan to implement it, or request a revision.',
          hasSuggestions: false
        }
      })
      this.setStatus('waiting-permission')
      return
    }
  }

  // ---------- Item → part mapping ----------

  private upsertItem(item: ThreadItem, terminal: boolean): void {
    // Error items go through the same id-keyed upsert as everything else, so a
    // repeated lifecycle event for one error id updates in place instead of
    // appending a duplicate notice each time.
    const part =
      item.type === 'error'
        ? ({ type: 'text', text: `⚠️ ${item.message}` } as AssistantPart)
        : this.itemToPart(item, terminal)
    if (!part) return
    const message = this.ensureCurrent()
    const loc = this.itemLoc.get(item.id)
    if (loc) {
      loc.message.parts[loc.index] = part
      this.emitPart(loc.message, loc.index)
    } else {
      const index = message.parts.length
      message.parts[index] = part
      this.itemLoc.set(item.id, { message, index })
      this.emitPart(message, index)
    }
  }

  private itemToPart(item: ThreadItem, terminal: boolean): AssistantPart | null {
    switch (item.type) {
      case 'agent_message':
        return { type: 'text', text: item.text ?? '' }
      case 'reasoning':
        return { type: 'thinking', text: item.text ?? '' }
      case 'command_execution': {
        const out = item.aggregated_output ?? ''
        const withExit =
          item.exit_code != null && item.exit_code !== 0
            ? `${out}${out ? '\n' : ''}[exit ${item.exit_code}]`
            : out
        return {
          type: 'tool',
          toolUseId: item.id,
          name: 'Bash', // renders as the Terminal card, with `command` as the summary
          input: { command: item.command },
          output: withExit ? cap(withExit) : undefined,
          status: cmdStatus(item.status)
        }
      }
      case 'file_change':
        return {
          type: 'tool',
          toolUseId: item.id,
          name: 'Edit', // renders as the Edit card; summary is the first path
          input: { file_path: item.changes[0]?.path, changes: item.changes },
          output: item.changes.map((c) => `${c.kind.padEnd(6)} ${c.path}`).join('\n'),
          status: item.status === 'completed' ? 'success' : 'error'
        }
      case 'mcp_tool_call':
        return {
          type: 'tool',
          toolUseId: item.id,
          // `mcp__server__tool` — ToolCard strips the `mcp__` prefix for the label.
          name: `mcp__${item.server}__${item.tool}`,
          input: item.arguments,
          output: this.mcpOutput(item),
          // Image results (e.g. an image-generation tool) render inline as a
          // screenshot on the tool card.
          outputImages: this.mcpImages(item),
          status: cmdStatus(item.status)
        }
      case 'web_search':
        return {
          type: 'tool',
          toolUseId: item.id,
          name: 'WebSearch',
          input: { query: item.query },
          // web_search items carry no status field, so derive it from the
          // lifecycle: only 'completed' means the results are back.
          status: terminal ? 'success' : 'running'
        }
      case 'todo_list':
        return {
          type: 'tool',
          toolUseId: item.id,
          name: 'TodoWrite', // reuses the live task-checklist card
          input: {
            todos: item.items.map((t) => ({
              content: t.text,
              status: t.completed ? 'completed' : 'pending'
            }))
          },
          status: 'success'
        }
      default:
        return null
    }
  }

  private mcpOutput(item: { result?: { content?: unknown }; error?: { message: string } }): string | undefined {
    if (item.error) return item.error.message
    const content = item.result?.content
    if (!Array.isArray(content)) return undefined
    const text = content
      .map((c: { type?: string; text?: string }) => (c?.type === 'text' ? (c.text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
    return text ? cap(text) : undefined
  }

  /** Pulls image blocks out of an MCP tool result (MCP shape: {data, mimeType}). */
  private mcpImages(item: { result?: { content?: unknown } }):
    | { mediaType: string; data: string }[]
    | undefined {
    const content = item.result?.content
    if (!Array.isArray(content)) return undefined
    const images: { mediaType: string; data: string }[] = []
    for (const c of content as Array<Record<string, unknown>>) {
      if (c?.type !== 'image') continue
      const data = typeof c.data === 'string' ? c.data : undefined
      if (!data) continue
      const mediaType = typeof c.mimeType === 'string' ? c.mimeType : 'image/png'
      images.push({ mediaType, data })
    }
    return images.length ? images : undefined
  }

  /**
   * On turn end (especially an interrupt), mark any tool part still shown as
   * running as errored. An aborted stream can end without a terminal item event,
   * which would otherwise leave the card spinning forever — and persist that way.
   */
  private terminalizeRunning(): void {
    const message = this.current
    if (!message) return
    let changed = false
    message.parts.forEach((part, index) => {
      if (part && part.type === 'tool' && (part.status === 'running' || part.status === 'pending')) {
        message.parts[index] = { ...part, status: 'error' }
        this.emit({
          type: 'tool-update',
          chatId: this.chat.id,
          messageId: message.id,
          toolUseId: part.toolUseId,
          patch: { status: 'error' }
        })
        changed = true
      }
    })
    if (changed) this.store.saveChatSoon(this.chat.id)
  }

  // ---------- Control ----------

  async interrupt(): Promise<void> {
    this.interrupted = true
    this.pending.length = 0
    this.abort?.abort()
    this.clearPlanReview()
    this.setStatus('idle')
  }

  async setModel(model?: string): Promise<void> {
    this.chat.model = model || undefined
    this.optionsDirty = true
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    if (mode !== 'plan') this.clearPlanReview()
    this.chat.permissionMode = mode
    this.optionsDirty = true
  }

  // ---- Unsupported-by-Codex surface: safe no-ops / empty introspection ----

  async stopBackgroundJob(): Promise<void> {}

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const review = this.planReview
    if (!review || review.requestId !== requestId) return
    this.planReview = null
    this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })

    if (decision.behavior === 'allow') {
      const prior = this.chat.modeBeforePlan
      const restore = prior && prior !== 'plan' ? prior : 'default'
      this.chat.modeBeforePlan = undefined
      this.chat.permissionMode = restore
      this.optionsDirty = true
      this.emit({
        type: 'meta',
        chatId: this.chat.id,
        patch: { permissionMode: restore, modeBeforePlan: undefined }
      })
      this.pushMessage({
        id: randomUUID(),
        role: 'event',
        kind: 'info',
        text: 'Plan approved. Codex is implementing it.',
        ts: Date.now()
      })
      this.pending.push(
        {
          ...this.buildInput(
            `The user approved the following plan. Implement it completely now.\n\n<approved_plan>\n${review.plan}\n</approved_plan>`,
            []
          ),
          userMessageId: review.userMessageId
        }
      )
    } else {
      const feedback = decision.message?.trim() || 'Revise the plan and propose it again.'
      const feedbackId = randomUUID()
      this.pushMessage({ id: feedbackId, role: 'user', text: feedback, ts: Date.now() })
      this.pending.push(
        {
          ...this.buildInput(
            `The user requested changes to the proposed plan. Stay in Plan mode and produce a revised proposal.\n\n<previous_plan>\n${review.plan}\n</previous_plan>\n\n<plan_feedback>\n${feedback}\n</plan_feedback>`,
            []
          ),
          userMessageId: feedbackId
        }
      )
    }
    this.chat.updatedAt = Date.now()
    this.store.saveChat(this.chat.id)
    void this.drain()
  }

  private clearPlanReview(): void {
    if (!this.planReview) return
    const { requestId } = this.planReview
    this.planReview = null
    this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
  }

  async rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    const checkpoint = this.checkpoints.get(userMessageId)
    if (!checkpoint) {
      return { canRewind: false, error: 'No Codex workspace checkpoint is available for this turn.' }
    }
    return rewindWorkspaceCheckpoint(this.chat.cwd, checkpoint, dryRun)
  }

  async mcpStatus(): Promise<McpServerInfo[]> {
    return []
  }

  async mcpReconnect(): Promise<OpResult> {
    return { ok: false, error: 'Not supported for Codex sessions.' }
  }

  async mcpToggle(): Promise<OpResult> {
    return { ok: false, error: 'Not supported for Codex sessions.' }
  }

  async listModels(): Promise<ModelOption[]> {
    // No SDK model list; the renderer falls back to the static MODEL_OPTIONS,
    // which carries the Codex entries.
    return []
  }

  async listAgents(): Promise<AgentInfo[]> {
    return []
  }

  async accountInfo(): Promise<AccountInfo | null> {
    return null
  }

  async usageInfo(): Promise<UsageInfo | null> {
    return null
  }

  dispose(): void {
    this.disposed = true
    this.dead = true
    this.abort?.abort()
    this.clearPlanReview()
    // Clean temp copies for queued turns that will now never run.
    for (const t of this.pending) {
      for (const f of t.temps) {
        try {
          rmSync(f, { force: true })
        } catch {
          // best-effort cleanup
        }
      }
    }
    this.pending.length = 0
  }
}
