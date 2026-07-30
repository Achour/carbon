import { randomUUID } from 'node:crypto'
import {
  createSdkMcpServer,
  query,
  tool,
  type ModelInfo,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type {
  AccountInfo,
  AgentInfo,
  AssistantMessage,
  AssistantPart,
  Attachment,
  BackgroundJob,
  ChatData,
  ChatMeta,
  ChatOptionsPatch,
  ChatStatus,
  EffortId,
  ElementRef,
  FastModeState,
  FastModeStatus,
  McpServerInfo,
  ModelOption,
  ModelSwitchInfo,
  OpResult,
  PermissionDecision,
  PermissionModeId,
  Provider,
  RewindResult,
  ServiceTier,
  SlashCommand,
  ToolPart,
  UsageInfo
} from '@shared/types'
import {
  CODEX_DEFAULT_MODEL,
  MODEL_OPTIONS,
  claudeModelContextWindow,
  claudeModelLabel,
  effortForProvider,
  modelDisplayName,
  modelLabel,
  providerForModel
} from '@shared/types'
import { CODEX_SLASH_COMMANDS, parseCodexSlashCommand } from '@shared/codexCommands'
import type { Store } from './store'
import type { PreviewManager } from './preview'
import { CodexSession, generateCodexText } from './codex'
import { composePrompt, withTimeout, type AgentSession, type Emit } from './session'
import { DeltaCoalescer } from './deltaCoalescer'
import { TITLE_SYSTEM, buildTitlePrompt, cleanTitle, deriveTitle, firstUserText } from './titles'
import {
  HANDOFF_BRIEF_SYSTEM,
  HANDOFF_FALLBACK_CHARS,
  HANDOFF_TIMEOUT_MS,
  HANDOFF_TRANSCRIPT_CHARS,
  buildHandoffBriefPrompt,
  buildHandoffContext,
  buildPlanImplementPrompt,
  serializeTranscript
} from './handoff'

/**
 * Appended to the claude_code preset. The GUI renders ```mermaid fenced blocks
 * as diagrams (in chat replies and in plan documents), so we nudge the agent to
 * reach for Mermaid instead of ASCII art when a picture would help.
 */
const GUI_SYSTEM_APPEND = `You are running inside a desktop GUI (not a terminal). The GUI renders any \`\`\`mermaid fenced code block as a real rendered diagram — this applies to your chat replies AND to plan documents you write for ExitPlanMode. When a diagram would make an explanation or a plan clearer (flows, sequences, architecture, state), draw it with a Mermaid fenced block (e.g. flowchart, sequenceDiagram) rather than ASCII art or box-drawing characters. Keep diagrams valid and reasonably small; label nodes clearly.`

/**
 * An in-process MCP server giving the agent control of the live preview for the
 * chat's project: start/stop the dev server, navigate, screenshot the running
 * page, and read its console — so it can verify its own edits end-to-end.
 */
function buildPreviewServer(
  cwd: string,
  preview: PreviewManager
): ReturnType<typeof createSdkMcpServer> {
  const text = (t: string): { content: Array<{ type: 'text'; text: string }> } => ({
    content: [{ type: 'text', text: t }]
  })
  return createSdkMcpServer({
    name: 'preview',
    version: '1.0.0',
    tools: [
      tool(
        'status',
        'Get the dev-server preview status for this project: whether it is running and its local URL.',
        {},
        async () => text(JSON.stringify(preview.state(cwd)))
      ),
      tool(
        'start',
        'Start this project\'s dev server (command auto-detected from package.json). Waits until the local URL is ready and opens the in-app preview. Use before screenshotting.',
        {},
        async () => text(JSON.stringify(await preview.startAndWait(cwd)))
      ),
      tool('stop', 'Stop this project\'s dev server.', {}, async () =>
        text(JSON.stringify(preview.stop(cwd)))
      ),
      tool(
        'navigate',
        'Point the in-app preview browser at a URL (e.g. a specific route of the running app).',
        { url: z.string().describe('The URL to load in the preview.') },
        async ({ url }) => {
          const res = await preview.navigate(cwd, url)
          return text(res.ok ? `Navigated to ${url}` : `Failed to navigate: ${res.error ?? 'unknown'}`)
        }
      ),
      tool(
        'screenshot',
        'Capture a screenshot of the current preview page to see the running app as the user sees it. Start the dev server first if it is not running.',
        {},
        async () => {
          const data = await preview.screenshot(cwd)
          if (!data) {
            return text('No preview is open to screenshot. Start the dev server (preview.start) or navigate first.')
          }
          return { content: [{ type: 'image' as const, data, mimeType: 'image/png' }] }
        }
      ),
      tool(
        'console',
        'Read recent console output and errors from the running preview app (browser console + dev-server errors).',
        {},
        async () => text(preview.recentConsole(cwd) || 'No console output captured yet.')
      )
    ]
  })
}

/** Pulls image blocks out of a tool_result's content (e.g. preview_screenshot). */
function extractImages(content: unknown): { mediaType: string; data: string }[] | undefined {
  if (!Array.isArray(content)) return undefined
  const images: { mediaType: string; data: string }[] = []
  for (const c of content as Array<Record<string, unknown>>) {
    if (c?.type !== 'image') continue
    // Anthropic shape: { source: { media_type, data } }. MCP shape: { data, mimeType }.
    const source = c.source as { media_type?: string; data?: string } | undefined
    const data = source?.data ?? (typeof c.data === 'string' ? c.data : undefined)
    if (!data) continue
    const mediaType = source?.media_type ?? (typeof c.mimeType === 'string' ? c.mimeType : 'image/png')
    images.push({ mediaType, data })
  }
  return images.length ? images : undefined
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

interface InputQueue {
  push(msg: SDKUserMessage): void
  end(): void
  iterate(): AsyncGenerator<SDKUserMessage>
}

function createInputQueue(): InputQueue {
  const queue: SDKUserMessage[] = []
  let notify: (() => void) | null = null
  let done = false
  return {
    push(msg) {
      queue.push(msg)
      notify?.()
    },
    end() {
      done = true
      notify?.()
    },
    async *iterate() {
      while (true) {
        while (queue.length > 0) yield queue.shift()!
        if (done) return
        await new Promise<void>((resolve) => {
          notify = resolve
        })
        notify = null
      }
    }
  }
}

interface PendingPermission {
  resolve: (result: PermissionResult) => void
  suggestions?: PermissionUpdate[]
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

/**
 * The CLI emits internal telemetry lines (e.g. `[ede_diagnostic] result_type=…`
 * when a turn is aborted / a queued message is force-sent) as error results.
 * They aren't real failures, so they must not render as scary error cards.
 */
const isBenignTurnError = (text: string): boolean => text.includes('[ede_diagnostic]')

/**
 * The SDK's default row is `value: 'default'`; the app uses '' to mean "no model
 * override", so normalize it — otherwise the picker shows two Defaults (this one
 * plus the app's own '' entry) and a chat left on the app default ('') wouldn't
 * match this row. `resolvedModel` (e.g. 'sonnet' → 'claude-sonnet-5') lets the
 * picker match chats pinned to the older static model ids against the alias row
 * that now covers them, and lets the composer chip name the model behind Default.
 */
function toModelOption(m: ModelInfo): ModelOption {
  return {
    id: m.value === 'default' ? '' : m.value,
    resolvedModel: m.resolvedModel,
    label: claudeModelLabel(m.displayName, m.resolvedModel),
    description: m.description,
    provider: 'claude',
    contextWindow: claudeModelContextWindow(m.description, m.resolvedModel),
    supportsFastMode: m.supportsFastMode
  }
}

const TITLE_MODEL = 'claude-haiku-4-5-20251001'

/**
 * One-shot, tool-less Claude call. Deliberately bare — a custom (non-preset)
 * system prompt, no MCP, no project settings, one turn — so it stays cheap and
 * can't touch the repo. Backs the title and handoff-brief generators. Returns
 * null on any failure so callers can fall back.
 */
async function generateClaudeText(
  cwd: string,
  model: string | undefined,
  systemPrompt: string,
  prompt: string
): Promise<string | null> {
  const q = query({
    prompt,
    options: {
      cwd: cwd || undefined,
      model,
      systemPrompt,
      settingSources: [],
      allowedTools: [],
      maxTurns: 1,
      permissionMode: 'default'
    }
  })
  try {
    let out = ''
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') out += block.text
        }
      } else if (msg.type === 'result') {
        break
      }
    }
    return out.trim() || null
  } catch {
    return null
  } finally {
    try {
      q.close()
    } catch {
      // already closed
    }
  }
}

/** Terse Haiku chat title from the opening exchange; null keeps the placeholder. */
async function generateClaudeTitle(cwd: string, userText: string): Promise<string | null> {
  const out = await generateClaudeText(cwd, TITLE_MODEL, TITLE_SYSTEM, buildTitlePrompt(userText))
  return out ? cleanTitle(out) || null : null
}

class ClaudeSession implements AgentSession {
  private q: Query
  private input = createInputQueue()
  private current: AssistantMessage | null = null
  private jsonAcc = new Map<number, string>()
  // Route a tool's result (which lands on a later `user` message, matched by
  // toolUseId) back to its streamed part. Entries are pruned the moment a result
  // is applied (see handleToolResults) so these stay ~O(in-flight tools) instead
  // of growing for the whole session; MAX_TOOL_LOC is a backstop for the residue
  // of tools that never resolve (e.g. an interrupted turn's 'running' parts).
  private static readonly MAX_TOOL_LOC = 2000
  private toolLoc = new Map<string, { message: AssistantMessage; index: number }>()
  // Sub-agent tool calls live inside a parent Task tool's `children`, not a
  // message's parts — so they need their own location map for result matching.
  private childToolLoc = new Map<string, { parent: ToolPart; index: number }>()
  private pending = new Map<string, PendingPermission>()
  /** Serializes prompt enqueues so a send can await its handoff context (see send). */
  private sendChain: Promise<void> = Promise.resolve()
  /** Bumped by interrupt so sends still waiting in the chain are dropped, not queued. */
  private sendEpoch = 0
  private initModel?: string
  /** Exact model name of the most recent assistant turn; keys into modelUsage. */
  private lastTurnModel?: string
  /** Last Fast status seen from the CLI; the renderer only hears the changes. */
  private fastMode?: FastModeStatus
  // Coalesces streaming deltas (~80ms) before IPC. Deps are read lazily so this
  // field initializer doesn't depend on when `emit`/`chat`/`store` are assigned.
  private readonly deltas = new DeltaCoalescer(
    (ev) => this.emit(ev),
    () => this.chat.id,
    () => this.store.saveChatSoon(this.chat.id),
    () => this.disposed
  )
  // Resolves once the SDK `init` message arrives (or the session dies), so
  // control requests (mcp status, models, account, usage) issued right after a
  // lazily-started session wait for the CLI to be ready instead of racing it.
  private readonly ready: Promise<void>
  private resolveReady!: () => void
  dead = false
  // Set the instant `dispose()` is called (session superseded / chat deleted).
  // `dead` is also set when the pump ends naturally, so it can't distinguish the
  // two — this flag suppresses the late async emits (a delayed pump `finally`, a
  // pending flush timer, buffered SDK messages) that would otherwise clobber a
  // *new* session now owning the same chat id.
  private disposed = false
  // Set while an intentional interrupt (Stop, or force-sending a queued message)
  // is in flight, so the error `result` the SDK emits for the aborted turn isn't
  // surfaced as a scary failure. Cleared on the first result after the interrupt.
  private interruptedTurn = false
  // True from input enqueue until the SDK's terminal result. If the long-lived
  // stream ends cleanly in between, surface that as a failed turn instead of
  // silently returning to idle with only the user's message persisted.
  private turnActive = false
  // Last status emitted, so consecutive duplicates (e.g. interrupt() then the
  // turn's `result` both emitting 'idle') collapse to one — consumers get a
  // clean level-triggered stream and don't each need to edge-detect.
  private lastEmittedStatus: ChatStatus | null = null
  private backgroundJobCount = 0
  // Guards the one-shot AI title: set the first time we try, so later turns in
  // this run never re-title. `titledResumed` skips chats that already had a turn
  // in a prior run (they had their shot; we don't retro-title on every restart).
  private titledOnce = false
  private titlePending = false
  private readonly titledResumed: boolean

  get idle(): boolean {
    return (
      this.lastEmittedStatus === 'idle' &&
      this.pending.size === 0 &&
      this.backgroundJobCount === 0
    )
  }

  constructor(
    private chat: ChatData,
    private emit: Emit,
    private store: Store,
    private onDead: () => void,
    private onCommands: (commands: SlashCommand[]) => void,
    private preview: PreviewManager
  ) {
    this.titledResumed = !!chat.sessionId
    this.ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve
    })
    this.q = query({
      prompt: this.input.iterate(),
      options: {
        cwd: chat.cwd,
        resume: chat.sessionId,
        model: chat.model || undefined,
        effort: effortForProvider(chat.effort, 'claude'),
        settings: { fastMode: chat.serviceTier === 'fast' },
        permissionMode: chat.permissionMode,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        // Track file changes per user message so the UI can rewind the working
        // tree back to any prompt (see rewindFiles). Checkpoints live in the CLI
        // process, so they only cover messages sent since this session started.
        enableFileCheckpointing: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: GUI_SYSTEM_APPEND },
        settingSources: ['user', 'project', 'local'],
        mcpServers: { preview: buildPreviewServer(chat.cwd, preview) },
        canUseTool: async (toolName, input, opts) => {
          // The preview tools are safe, local, and app-mediated — never prompt.
          // Exception: starting/stopping the dev server is a side effect, so it's
          // blocked in plan mode (read-only) until the plan is approved.
          if (toolName.startsWith('mcp__preview__')) {
            const sideEffecting =
              toolName === 'mcp__preview__start' || toolName === 'mcp__preview__stop'
            if (sideEffecting && this.chat.permissionMode === 'plan') {
              return {
                behavior: 'deny',
                message:
                  'Starting or stopping the dev server is a side effect and is not allowed in plan mode. Note it in the plan — it can run once the plan is approved.'
              }
            }
            return { behavior: 'allow', updatedInput: input }
          }
          return this.requestPermission(toolName, input, opts)
        },
        stderr: (data) => {
          if (process.env.NODE_ENV !== 'production') console.error(`[claude ${chat.id}]`, data)
        }
      }
    })
    void this.pump()
  }

  private setStatus(status: ChatStatus): void {
    if (status === this.lastEmittedStatus) return
    this.lastEmittedStatus = status
    this.emit({ type: 'status', chatId: this.chat.id, status })
  }

  /** Normalizes the SDK's slash-command list and pushes it to the renderer + cache. */
  private emitCommands(
    raw: Array<{ name: string; description: string; argumentHint?: string; aliases?: string[] }>
  ): void {
    const commands: SlashCommand[] = raw.map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint || undefined,
      aliases: c.aliases
    }))
    this.emit({ type: 'commands', chatId: this.chat.id, cwd: this.chat.cwd, commands })
    this.onCommands(commands)
  }

  /**
   * Fast is a request, not a setting: the CLI answers back whether it is really
   * serving it and, when it isn't, why (an account that doesn't allow the extra
   * usage Fast bills to, a rate-limit cooldown, a model without it). Older CLIs
   * omit the field — stay quiet then, so the composer says nothing rather than
   * something wrong.
   */
  private emitFastMode(state?: FastModeState, reason?: string): void {
    if (!state) return
    if (this.fastMode?.state === state && this.fastMode.reason === reason) return
    this.fastMode = { state, reason }
    this.emit({ type: 'fast-mode', chatId: this.chat.id, status: this.fastMode })
  }

  private pushMessage(message: ChatData['messages'][number]): void {
    this.deltas.flush()
    this.chat.messages.push(message)
    this.chat.updatedAt = Date.now()
    this.emit({ type: 'message', chatId: this.chat.id, message })
    this.store.saveChatSoon(this.chat.id)
  }

  /**
   * Replace the placeholder title with a terse AI summary of the user's opening
   * message. Fired on the first substantive event from the conversation stream,
   * after its long-lived process has consumed the prompt; it still overlaps the
   * rest of the turn. Best-effort and fire-once: skips manually-renamed and
   * resumed chats.
  */
  private async maybeGenerateTitle(): Promise<void> {
    if (this.disposed || this.titledOnce || this.titledResumed || this.chat.titleManual) return
    // Only the tail of a long chat is hydrated, so its opening message may not be
    // in memory at all. `titledResumed` already covers every realistic case (a
    // chat this long has a sessionId), but titling from the middle of someone's
    // history is a bad enough outcome to check rather than infer.
    if (this.store.hiddenBefore(this.chat.id) > 0) return
    const userText = firstUserText(this.chat.messages)
    if (!userText) return
    this.titledOnce = true
    this.setTitlePending(true)
    try {
      const title = await generateClaudeTitle(this.chat.cwd, userText)
      if (title && !this.disposed && !this.chat.titleManual) {
        this.chat.title = title
        this.emit({ type: 'meta', chatId: this.chat.id, patch: { title } })
        this.store.saveChatSoon(this.chat.id)
      }
    } finally {
      this.setTitlePending(false)
    }
  }

  private setTitlePending(pending: boolean): void {
    if (this.titlePending === pending) return
    this.titlePending = pending
    this.emit({ type: 'title-pending', chatId: this.chat.id, pending })
  }

  send(
    text: string,
    attachments: Attachment[] = [],
    label?: string,
    hiddenContext?: string | Promise<string | undefined>
  ): void {
    if (!this.chat.title) {
      // Instant placeholder from the first message; the AI title is generated in
      // parallel with the turn below (see maybeGenerateTitle) and swaps it in.
      this.chat.title = deriveTitle(text, label, attachments)
      this.emit({ type: 'meta', chatId: this.chat.id, patch: { title: this.chat.title } })
    }
    // The GUI message id doubles as the SDK message uuid (stamped on the input
    // below), so file checkpoints are keyed by it and rewindFiles can target it.
    const messageId = randomUUID()
    this.pushMessage({
      id: messageId,
      role: 'user',
      text,
      ts: Date.now(),
      ...(attachments.length ? { attachments } : {}),
      ...(label ? { label } : {})
    })
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { updatedAt: this.chat.updatedAt } })
    this.setStatus(this.chat.sessionId ? 'streaming' : 'starting')
    this.turnActive = true

    // Images go to the model as base64 blocks; other files are referenced by
    // path so Claude can Read them itself. Picked UI elements contribute a
    // screenshot (if captured) plus a text description of where they live.
    const content: Array<Record<string, unknown>> = []
    const elementBlocks: string[] = []
    for (const a of attachments) {
      if ((a.kind === 'image' || a.kind === 'element') && a.data && a.mediaType) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: a.mediaType, data: a.data }
        })
      }
      if (a.kind === 'element' && a.element) elementBlocks.push(describeElement(a.element))
    }
    const filePaths = attachments.filter((a) => a.kind === 'file' && a.path).map((a) => a.path!)
    const epoch = this.sendEpoch
    const finish = (ctx?: string): void => {
      if (this.disposed || epoch !== this.sendEpoch) return
      let prompt = composePrompt(text, ctx)
      if (filePaths.length) {
        const list = filePaths.map((p) => `- ${p}`).join('\n')
        prompt = `${prompt ? `${prompt}\n\n` : ''}Attached files:\n${list}`
      }
      if (elementBlocks.length) {
        prompt = `${prompt ? `${prompt}\n\n` : ''}${elementBlocks.join('\n\n')}`
      }
      if (prompt || content.length === 0) content.push({ type: 'text', text: prompt })
      this.input.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        uuid: messageId
      } as unknown as SDKUserMessage)
    }
    // Every send rides the chain so a plain message can never overtake one
    // still waiting on its handoff context (the echo above stays instant).
    this.sendChain = this.sendChain.then(
      () => Promise.resolve(hiddenContext).then(finish, () => finish())
    )
  }

  async interrupt(): Promise<void> {
    this.sendEpoch += 1
    this.denyAllPending(true)
    this.interruptedTurn = true
    try {
      await this.q.interrupt()
    } catch (err) {
      console.error('interrupt failed:', err)
    }
    this.terminalizeRunning('error')
    this.setStatus('idle')
  }

  private emitBackgroundJobs(jobs: BackgroundJob[]): void {
    const hadJobs = this.backgroundJobCount > 0
    this.backgroundJobCount = jobs.length
    this.emit({ type: 'background-jobs', chatId: this.chat.id, jobs })
    if (
      hadJobs &&
      jobs.length === 0 &&
      this.lastEmittedStatus === 'idle' &&
      !this.disposed &&
      !this.dead
    ) {
      this.terminalizeRunning('success')
    }
  }

  async setModel(model?: string): Promise<void> {
    try {
      await this.q.setModel(model || undefined)
    } catch (err) {
      console.error('setModel failed:', err)
    }
  }

  /** Change reasoning effort for subsequent responses in this live session. */
  private async setEffort(effort?: EffortId): Promise<void> {
    try {
      await this.q.applyFlagSettings({
        effortLevel: effortForProvider(effort, 'claude') ?? null
      })
    } catch (err) {
      console.error('setEffort failed:', err)
    }
  }

  /** Stop a single background task; the SDK emits an updated set afterward. */
  async stopBackgroundJob(taskId: string): Promise<void> {
    try {
      await this.q.stopTask(taskId)
    } catch (err) {
      console.error('stopTask failed:', err)
    }
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    try {
      await this.q.setPermissionMode(mode)
    } catch (err) {
      console.error('setPermissionMode failed:', err)
    }
  }

  async setServiceTier(serviceTier: ServiceTier): Promise<void> {
    await this.control(
      () => this.q.applyFlagSettings({ fastMode: serviceTier === 'fast' }),
      undefined,
      'setServiceTier'
    )
  }

  /**
   * Runs an SDK control request bounded by two timeouts: one waiting for the
   * session to initialize, one on the request itself. A control request against
   * a session that never finished init (or a wedged CLI) otherwise hangs
   * forever and stalls the IPC call; here it degrades to the fallback value.
   */
  private async control<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
    try {
      await Promise.race([this.ready, new Promise<void>((r) => setTimeout(r, 6000))])
      if (this.dead) return fallback
      return await Promise.race([
        fn(),
        new Promise<T>((r) => setTimeout(() => r(fallback), 8000))
      ])
    } catch (err) {
      console.error(`${label} failed:`, err)
      return fallback
    }
  }

  /** Revert the working tree to its checkpoint at a user message (or preview it). */
  async rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    return this.control<RewindResult>(
      async () => {
        const res = await this.q.rewindFiles(userMessageId, { dryRun })
        return {
          canRewind: res.canRewind,
          error: res.error,
          filesChanged: res.filesChanged,
          insertions: res.insertions,
          deletions: res.deletions
        }
      },
      { canRewind: false, error: 'Rewind timed out.' },
      'rewindFiles'
    )
  }

  async mcpStatus(): Promise<McpServerInfo[]> {
    return this.control(
      async () => {
        const servers = await this.q.mcpServerStatus()
        return servers.map((s) => ({
          name: s.name,
          status: s.status,
          scope: s.scope,
          error: s.error,
          tools: s.tools?.map((t) => ({
            name: t.name,
            description: t.description,
            readOnly: t.annotations?.readOnly
          }))
        }))
      },
      [],
      'mcpServerStatus'
    )
  }

  async mcpReconnect(name: string): Promise<OpResult> {
    return this.control(
      async () => {
        await this.q.reconnectMcpServer(name)
        return { ok: true } as OpResult
      },
      { ok: false, error: 'Reconnect timed out.' },
      'reconnectMcpServer'
    )
  }

  async mcpToggle(name: string, enabled: boolean): Promise<OpResult> {
    return this.control(
      async () => {
        await this.q.toggleMcpServer(name, enabled)
        return { ok: true } as OpResult
      },
      { ok: false, error: 'Toggle timed out.' },
      'toggleMcpServer'
    )
  }

  async listModels(): Promise<ModelOption[]> {
    return this.control(
      async () => (await this.q.supportedModels()).map(toModelOption),
      [],
      'supportedModels'
    )
  }

  async listAgents(): Promise<AgentInfo[]> {
    return this.control(
      async () => {
        const agents = await this.q.supportedAgents()
        return agents.map((a) => ({ name: a.name, description: a.description, model: a.model }))
      },
      [],
      'supportedAgents'
    )
  }

  async accountInfo(): Promise<AccountInfo | null> {
    return this.control(
      async () => {
        const info = await this.q.accountInfo()
        return {
          email: info.email,
          organization: info.organization,
          subscriptionType: info.subscriptionType,
          apiProvider: info.apiProvider
        }
      },
      null,
      'accountInfo'
    )
  }

  async usageInfo(): Promise<UsageInfo | null> {
    return this.control(
      async () => {
        const u = await this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
        const windows: UsageInfo['windows'] = []
        const push = (
          label: string,
          w?: { utilization: number | null; resets_at: string | null } | null
        ): void => {
          if (w) windows.push({ label, utilization: w.utilization, resetsAt: w.resets_at })
        }
        const rl = u.rate_limits
        if (rl) {
          push('5-hour', rl.five_hour)
          push('7-day', rl.seven_day)
          push('7-day (Opus)', rl.seven_day_opus)
          push('7-day (Sonnet)', rl.seven_day_sonnet)
        }
        return {
          costUsd: u.session.total_cost_usd,
          linesAdded: u.session.total_lines_added,
          linesRemoved: u.session.total_lines_removed,
          subscriptionType: u.subscription_type,
          rateLimitsAvailable: u.rate_limits_available,
          windows
        }
      },
      null,
      'usage'
    )
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
    if (decision.behavior === 'allow') {
      // "Always allow" persists the rule: rewrite each suggestion's destination
      // from the SDK's default ('session') to 'localSettings' so the CLI writes
      // it to .claude/settings.local.json. Since sessions load settingSources
      // ['user','project','local'], the rule then survives restarts and applies
      // to future chats in this project. Mode/directory updates keep their scope.
      const persisted =
        decision.always && pending.suggestions?.length
          ? pending.suggestions.map((s) =>
              s.type === 'addRules' || s.type === 'replaceRules' || s.type === 'removeRules'
                ? { ...s, destination: 'localSettings' as const }
                : s
            )
          : undefined
      // A plan approval may carry the model and reasoning effort to implement
      // with. Send both live control requests before resolving approval: they
      // share the CLI transport, so the continuation starts with these values.
      if (pending.toolName === 'ExitPlanMode') {
        const patch: Partial<ChatMeta> = {}
        if (decision.model !== undefined) {
          const next = decision.model || undefined
          if (next !== this.chat.model) {
            this.chat.model = next
            void this.setModel(next)
            patch.model = next
          }
        }
        if (decision.effort !== undefined) {
          const effort = effortForProvider(decision.effort || undefined, 'claude')
          if (effort !== this.chat.effort) {
            this.chat.effort = effort
            void this.setEffort(effort)
            patch.effort = effort
          }
        }
        if (Object.keys(patch).length > 0)
          this.emit({ type: 'meta', chatId: this.chat.id, patch })
      }
      pending.resolve({
        behavior: 'allow',
        updatedInput: decision.updatedInput ?? pending.input,
        updatedPermissions: persisted
      })
      // Approving a plan returns to the mode the chat was in before plan
      // mode — unless the user opted into auto-accepting edits, which the
      // suggestions switch to acceptEdits themselves. A chat *created* in plan
      // mode never recorded a prior mode, so fall back to 'default' rather than
      // leaving it stuck read-only (unable to do the work the plan describes).
      if (pending.toolName === 'ExitPlanMode') {
        const restore = this.chat.modeBeforePlan ?? 'default'
        this.chat.modeBeforePlan = undefined
        if (restore !== 'plan' && !decision.always) {
          this.chat.permissionMode = restore
          this.emit({ type: 'meta', chatId: this.chat.id, patch: { permissionMode: restore } })
          void this.setPermissionMode(restore)
        }
        this.store.saveChatSoon(this.chat.id)
      }
    } else {
      this.markToolDenied(pending.toolUseId)
      pending.resolve({
        behavior: 'deny',
        message: decision.message || 'The user denied this request.',
        interrupt: false
      })
    }
    // Stay in `waiting-permission` while other parallel tool calls still await
    // the user; only resume `streaming` once the last request is handled.
    this.setStatus(this.pending.size > 0 ? 'waiting-permission' : 'streaming')
  }

  pendingPlan(requestId: string): string | null {
    const pending = this.pending.get(requestId)
    if (!pending || pending.toolName !== 'ExitPlanMode') return null
    const plan = (pending.input as Record<string, unknown> | undefined)?.plan
    return typeof plan === 'string' ? plan : null
  }

  private denyAllPending(interrupt: boolean): void {
    for (const [requestId, pending] of this.pending) {
      this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
      this.markToolDenied(pending.toolUseId)
      pending.resolve({ behavior: 'deny', message: 'The user denied this request.', interrupt })
    }
    this.pending.clear()
  }

  dispose(): void {
    this.setTitlePending(false)
    this.terminalizeRunning('error')
    this.disposed = true
    this.dead = true
    this.resolveReady()
    // Background tasks are per-process; the next session starts with none.
    this.emitBackgroundJobs([])
    this.deltas.flush()
    this.denyAllPending(true)
    this.input.end()
    try {
      this.q.close()
    } catch {
      // already closed
    }
  }

  private requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      signal: AbortSignal
      suggestions?: PermissionUpdate[]
      toolUseID: string
      requestId: string
      title?: string
      displayName?: string
      description?: string
      decisionReason?: string
    }
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const requestId = opts.requestId || randomUUID()
      this.pending.set(requestId, {
        resolve,
        suggestions: opts.suggestions,
        toolUseId: opts.toolUseID,
        toolName,
        input
      })
      this.emit({
        type: 'permission-request',
        chatId: this.chat.id,
        request: {
          id: requestId,
          chatId: this.chat.id,
          toolUseId: opts.toolUseID,
          toolName,
          input,
          title: opts.title,
          displayName: opts.displayName,
          description: opts.description,
          decisionReason: opts.decisionReason,
          hasSuggestions: Boolean(opts.suggestions?.length)
        }
      })
      this.setStatus('waiting-permission')
      opts.signal.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
          resolve({ behavior: 'deny', message: 'Request aborted.', interrupt: false })
        }
      })
    })
  }

  // ---------- Message pump ----------

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) {
        this.handle(msg)
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      if (!this.dead && !this.interruptedTurn && !isBenignTurnError(text)) {
        this.pushMessage({
          id: randomUUID(),
          role: 'event',
          kind: 'error',
          text,
          ts: Date.now()
        })
      }
      // The thrown error above is already the terminal failure for this turn.
      this.turnActive = false
    } finally {
      this.dead = true
      if (this.turnActive && !this.disposed && !this.interruptedTurn) {
        this.pushMessage({
          id: randomUUID(),
          role: 'event',
          kind: 'error',
          text: 'Claude exited before completing your message. It may not have been processed — please send it again.',
          ts: Date.now()
        })
      }
      this.turnActive = false
      // A process that dies before producing a normal result has stopped
      // competing for startup state, so this is the safe fallback for a turn
      // that never emitted assistant stream events.
      void this.maybeGenerateTitle()
      // Unblock any introspection waiting on init if the session died first.
      this.resolveReady()
      // If a newer session already owns this chat id (dispose superseded us),
      // stay silent — emitting idle / empty jobs here would clobber it.
      if (!this.disposed) {
        // The process (and any background tasks it owned) is gone.
        this.emitBackgroundJobs([])
        this.denyAllPending(false)
        this.terminalizeRunning('error')
        this.setStatus('idle')
      }
      this.store.saveChat(this.chat.id)
      this.onDead()
    }
  }

  private handle(msg: SDKMessage): void {
    // A message can arrive from the SDK subprocess after teardown; ignore it so
    // we don't emit events for a chat this session no longer represents.
    if (this.disposed) return
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.initModel = msg.model
          this.resolveReady()
          // Re-sent after a live `applyFlagSettings`, so a Fast toggle is
          // answered without waiting for the next turn to finish.
          this.emitFastMode(msg.fast_mode_state, msg.fast_mode_disabled_reason)
          if (msg.session_id && msg.session_id !== this.chat.sessionId) {
            this.chat.sessionId = msg.session_id
            this.emit({
              type: 'meta',
              chatId: this.chat.id,
              patch: { sessionId: msg.session_id }
            })
            this.store.saveChatSoon(this.chat.id)
          }
          // The available slash commands are known once the session initializes.
          void this.q
            .supportedCommands()
            .then((cmds) => {
              if (!this.dead) this.emitCommands(cmds)
            })
            .catch(() => {})
        } else if (msg.subtype === 'commands_changed') {
          // Skills/commands can appear mid-session as the agent enters subdirs.
          this.emitCommands((msg as unknown as { commands: SlashCommand[] }).commands)
        } else if (msg.subtype === 'compact_boundary') {
          this.pushMessage({
            id: randomUUID(),
            role: 'event',
            kind: 'compact',
            text: 'Context compacted',
            ts: Date.now()
          })
        } else if (msg.subtype === 'background_tasks_changed') {
          // Full live set on every change (REPLACE semantics) — the renderer
          // swaps its list wholesale.
          const tasks = (msg as unknown as {
            tasks: Array<{ task_id: string; task_type: string; description: string }>
          }).tasks
          const jobs: BackgroundJob[] = tasks.map((t) => ({
            id: t.task_id,
            type: t.task_type,
            description: t.description
          }))
          this.emitBackgroundJobs(jobs)
        } else if (msg.subtype === 'status' && 'permissionMode' in msg && msg.permissionMode) {
          const mode = msg.permissionMode
          if (
            (mode === 'default' ||
              mode === 'acceptEdits' ||
              mode === 'plan' ||
              mode === 'auto' ||
              mode === 'bypassPermissions') &&
            mode !== this.chat.permissionMode
          ) {
            this.chat.permissionMode = mode
            this.emit({ type: 'meta', chatId: this.chat.id, patch: { permissionMode: mode } })
            this.store.saveChatSoon(this.chat.id)
          }
        } else if (msg.subtype === 'permission_denied') {
          this.markToolDenied(msg.tool_use_id)
        }
        break

      case 'rate_limit_event': {
        const info = (msg as unknown as { rate_limit_info?: {
          status: 'allowed' | 'allowed_warning' | 'rejected'
          rateLimitType?: string
          utilization?: number
          resetsAt?: number
        } }).rate_limit_info
        if (info) {
          this.emit({
            type: 'rate-limit',
            chatId: this.chat.id,
            state: {
              status: info.status,
              rateLimitType: info.rateLimitType,
              utilization: info.utilization,
              resetsAt: info.resetsAt
            }
          })
        }
        break
      }

      case 'stream_event': {
        if (msg.parent_tool_use_id) break
        void this.maybeGenerateTitle()
        this.handleStreamEvent(msg.event)
        break
      }

      case 'assistant':
        if (msg.parent_tool_use_id) this.handleSubAgentAssistant(msg.parent_tool_use_id, msg)
        else {
          void this.maybeGenerateTitle()
          this.reconcileAssistant(msg)
        }
        break

      case 'user':
        if (msg.parent_tool_use_id) this.handleSubAgentToolResults(msg.parent_tool_use_id, msg.message)
        else this.handleToolResults(msg.message)
        break

      case 'result': {
        // Covers valid itemless/silent turns and failures before assistant output.
        void this.maybeGenerateTitle()
        this.turnActive = false
        // What the turn that just ran was actually served at.
        this.emitFastMode(msg.fast_mode_state, msg.fast_mode_disabled_reason)
        if ('modelUsage' in msg && msg.modelUsage) {
          // modelUsage is cumulative across the (resumed) session and keyed by
          // model name, so after switching models it holds an entry per model
          // used. Take the window of the model that produced this turn — not the
          // max, which would stick to the largest window ever seen (e.g. 1M)
          // after switching down to a smaller model like Sonnet.
          // Match the turn's model to its usage entry tolerating a '[1m]' suffix:
          // lastTurnModel comes back as 'claude-opus-4-8' while modelUsage keys it
          // as 'claude-opus-4-8[1m]', which would otherwise miss and fall back to
          // Math.max (sticking to the largest window ever seen this session).
          const canon = (s: string): string => s.replace(/\[1m\]$/i, '')
          const turnEntry = this.lastTurnModel
            ? (msg.modelUsage[this.lastTurnModel] ??
                Object.entries(msg.modelUsage).find(
                  ([k]) => canon(k) === canon(this.lastTurnModel!)
                )?.[1])
            : undefined
          const current = turnEntry?.contextWindow
          const windows = Object.values(msg.modelUsage)
            .map((m) => m.contextWindow)
            .filter((w): w is number => typeof w === 'number' && w > 0)
          const window =
            typeof current === 'number' && current > 0
              ? current
              : windows.length
                ? Math.max(...windows)
                : undefined
          if (window && window !== this.chat.contextWindow) {
            this.chat.contextWindow = window
            this.emit({ type: 'meta', chatId: this.chat.id, patch: { contextWindow: window } })
          }
        }
        const stats = {
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
          model: this.initModel,
          inputTokens: msg.usage?.input_tokens,
          outputTokens: msg.usage?.output_tokens
        }
        if (msg.subtype === 'success') {
          this.pushMessage({
            id: randomUUID(),
            role: 'event',
            kind: 'turn',
            text: '',
            ts: Date.now(),
            stats
          })
        } else {
          const errors =
            'errors' in msg && Array.isArray(msg.errors) && msg.errors.length
              ? msg.errors.join('\n')
              : msg.subtype
          // Skip errors from an intentional interrupt (the flag) and the CLI's
          // internal diagnostics (the text) — neither is a real failure. The
          // diagnostic can surface on the *resend* turn, after the flag has been
          // cleared, so the text check is what makes this robust.
          if (!this.interruptedTurn && !isBenignTurnError(errors)) {
            this.pushMessage({
              id: randomUUID(),
              role: 'event',
              kind: 'error',
              text: errors,
              ts: Date.now(),
              stats
            })
          }
        }
        this.interruptedTurn = false
        // Background tasks can legitimately outlive the parent turn. Keep
        // their tool cards live until the SDK reports the job set empty.
        if (this.backgroundJobCount === 0) {
          this.terminalizeRunning(msg.subtype === 'success' ? 'success' : 'error')
        }
        this.current = null
        this.setStatus('idle')
        this.emit({ type: 'meta', chatId: this.chat.id, patch: { updatedAt: this.chat.updatedAt } })
        this.store.saveChat(this.chat.id)
        break
      }

      default:
        break
    }
  }

  private ensureCurrent(): AssistantMessage {
    if (!this.current) {
      this.current = { id: randomUUID(), role: 'assistant', parts: [], ts: Date.now() }
      this.chat.messages.push(this.current)
      this.emit({ type: 'message', chatId: this.chat.id, message: this.current })
    }
    return this.current
  }

  private emitPart(message: AssistantMessage, index: number): void {
    this.deltas.flush()
    this.emit({
      type: 'part',
      chatId: this.chat.id,
      messageId: message.id,
      partIndex: index,
      part: message.parts[index]
    })
    this.store.saveChatSoon(this.chat.id)
  }

  /** Ensure interrupted/disposed turns never leave infinite tool spinners behind. */
  private terminalizeRunning(status: 'success' | 'error'): void {
    const settle = (part: ToolPart): boolean => {
      let changed = false
      if (part.status === 'running' || part.status === 'pending') {
        part.status = status
        changed = true
      }
      if (part.children) {
        for (const child of part.children) {
          if (child?.type === 'tool' && settle(child)) changed = true
        }
      }
      return changed
    }
    for (const message of this.chat.messages) {
      if (message.role !== 'assistant') continue
      message.parts.forEach((part, index) => {
        if (part?.type === 'tool' && settle(part)) this.emitPart(message, index)
      })
    }
  }

  private handleStreamEvent(event: {
    type: string
    index?: number
    content_block?: unknown
    delta?: unknown
  }): void {
    switch (event.type) {
      case 'message_start':
        this.ensureCurrent()
        this.jsonAcc.clear()
        break

      case 'content_block_start': {
        const message = this.ensureCurrent()
        const index = event.index ?? message.parts.length
        const block = event.content_block as {
          type: string
          id?: string
          name?: string
        }
        let part: AssistantPart
        if (block.type === 'text') {
          part = { type: 'text', text: '' }
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          part = { type: 'thinking', text: '' }
        } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          part = {
            type: 'tool',
            toolUseId: block.id ?? randomUUID(),
            name: block.name ?? 'Tool',
            status: 'pending'
          }
          this.jsonAcc.set(index, '')
        } else {
          part = { type: 'text', text: '' }
        }
        message.parts[index] = part
        if (part.type === 'tool') {
          this.toolLoc.set(part.toolUseId, { message, index })
          this.capMap(this.toolLoc)
        }
        this.emitPart(message, index)
        break
      }

      case 'content_block_delta': {
        const message = this.current
        if (!message) break
        const index = event.index ?? message.parts.length - 1
        const part = message.parts[index]
        if (!part) break
        const delta = event.delta as {
          type: string
          text?: string
          thinking?: string
          partial_json?: string
        }
        if (delta.type === 'text_delta' && part.type === 'text') {
          part.text += delta.text ?? ''
          this.deltas.queue(message.id, index, delta.text ?? '')
        } else if (delta.type === 'thinking_delta' && part.type === 'thinking') {
          part.text += delta.thinking ?? ''
          this.deltas.queue(message.id, index, delta.thinking ?? '')
        } else if (delta.type === 'input_json_delta') {
          this.jsonAcc.set(index, (this.jsonAcc.get(index) ?? '') + (delta.partial_json ?? ''))
        }
        break
      }

      case 'content_block_stop': {
        const message = this.current
        if (!message) break
        const index = event.index ?? message.parts.length - 1
        const part = message.parts[index]
        if (part?.type === 'tool') {
          const raw = this.jsonAcc.get(index)
          if (raw) {
            try {
              part.input = JSON.parse(raw)
            } catch {
              part.input = raw
            }
          }
          part.status = 'running'
          this.jsonAcc.delete(index)
          this.emitPart(message, index)
        }
        break
      }

      default:
        break
    }
  }

  /**
   * The usage block on each assistant message reflects the full prompt of
   * that API call — which is exactly what currently occupies the context
   * window, so `input + cache reads + cache writes + output` is the live
   * context size.
   */
  private updateContext(usage: unknown): void {
    if (!usage || typeof usage !== 'object') return
    const u = usage as Record<string, unknown>
    const n = (key: string): number => (typeof u[key] === 'number' ? (u[key] as number) : 0)
    const total =
      n('input_tokens') +
      n('cache_read_input_tokens') +
      n('cache_creation_input_tokens') +
      n('output_tokens')
    if (total > 0 && total !== this.chat.contextTokens) {
      this.chat.contextTokens = total
      this.emit({ type: 'meta', chatId: this.chat.id, patch: { contextTokens: total } })
      this.store.saveChatSoon(this.chat.id)
    }
  }

  private reconcileAssistant(msg: SDKAssistantMessage): void {
    const model = (msg.message as { model?: string }).model
    if (typeof model === 'string' && model) this.lastTurnModel = model
    this.updateContext((msg.message as { usage?: unknown }).usage)
    const message = this.ensureCurrent()
    // Index the already-streamed tool parts of THIS message by id, so a result
    // that somehow landed before the final assistant message is carried across
    // the wholesale replace below. Read them from the message's own parts rather
    // than toolLoc — whose entries are pruned as results land — so pruning can't
    // strand this lookup.
    const priorTools = new Map<string, ToolPart>()
    for (const part of message.parts) {
      if (part?.type === 'tool') priorTools.set(part.toolUseId, part)
    }
    // The CLI ships thinking blocks with `thinking` emptied and only the
    // `signature` left, so the final message is not a superset of what streamed:
    // taking it verbatim would erase the deltas. Match the streamed thoughts by
    // ordinal and keep them; a block that carried no text either way is dropped
    // rather than kept as an empty part, since an empty part is still a message
    // in the transcript and in the renderer's layout.
    const priorThoughts = message.parts
      .filter((part) => part?.type === 'thinking' && part.text)
      .map((part) => (part as { text: string }).text)
    let thoughtIndex = 0
    const parts: AssistantPart[] = []
    for (const block of msg.message.content as unknown as Array<Record<string, unknown>>) {
      const type = block.type as string
      if (type === 'text') {
        parts.push({ type: 'text', text: (block.text as string) ?? '' })
      } else if (type === 'thinking') {
        const text = (block.thinking as string) || (priorThoughts[thoughtIndex] ?? '')
        thoughtIndex++
        if (text) parts.push({ type: 'thinking', text })
      } else if (type === 'redacted_thinking') {
        parts.push({ type: 'thinking', text: '[Thinking redacted]' })
      } else if (type === 'tool_use' || type === 'server_tool_use') {
        const toolUseId = block.id as string
        const existing = priorTools.get(toolUseId)
        parts.push({
          type: 'tool',
          toolUseId,
          name: (block.name as string) ?? 'Tool',
          input: block.input,
          status: existing?.status === 'success' || existing?.status === 'error'
            ? existing.status
            : 'running',
          output: existing?.output,
          outputImages: existing?.outputImages,
          denied: existing?.denied,
          // Keep sub-agent activity across the reconcile (same array ref, so
          // childToolLoc indexes stay valid).
          children: existing?.children
        })
      }
    }
    // No parts normally means the final message told us nothing the stream had
    // not already carried, so the streamed ones stand. A thinking-only turn is
    // the exception: it reconciles to nothing on purpose, and keeping its husk
    // is what would leave a blank message behind.
    const streamedNothing = message.parts.every(
      (part) => !part || ((part.type === 'text' || part.type === 'thinking') && !part.text)
    )
    if (parts.length > 0 || streamedNothing) {
      message.parts = parts
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        if (part.type === 'tool') this.toolLoc.set(part.toolUseId, { message, index: i })
      }
      this.capMap(this.toolLoc)
      this.deltas.flush()
      this.emit({ type: 'message', chatId: this.chat.id, message })
    }
    this.chat.updatedAt = Date.now()
    this.store.saveChatSoon(this.chat.id)
    this.current = null
  }

  /**
   * A tool result mutates the assistant message that DECLARED the tool, which is
   * usually not the live tail — later assistant turns and their user messages have
   * been appended since. The store's incremental write only re-serializes the
   * tail, freshly-appended messages, and ones holding a live tool; a tool that was
   * snapshotted absent (a message persisted mid-stream as thinking-only) and then
   * streamed in and terminalized while buried matches none of those, so its output
   * would not reach disk until the next full reconcile — and would be lost on a
   * hard crash before then. Flag it, the same contract codex.ts uses for late
   * fileChanges. The tail is always re-serialized anyway, so skip the flag (and its
   * O(messages) id scan) for it.
   */
  private flagBuriedMutation(messageId: string): void {
    const messages = this.chat.messages
    const tail = messages[messages.length - 1]
    if (tail && tail.id !== messageId) this.store.markMessageDirty(this.chat.id, messageId)
  }

  private handleToolResults(message: { content?: unknown }): void {
    const content = message.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block?.type !== 'tool_result') continue
      const loc = this.toolLoc.get(block.tool_use_id)
      if (!loc) continue
      const part = loc.message.parts[loc.index]
      if (part?.type !== 'tool') continue
      let output = ''
      if (typeof block.content === 'string') {
        output = block.content
      } else if (Array.isArray(block.content)) {
        output = block.content
          .map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
          .filter(Boolean)
          .join('\n')
      }
      part.output = output.length > 100_000 ? `${output.slice(0, 100_000)}\n… (truncated)` : output
      part.outputImages = extractImages(block.content)
      if (!part.denied) part.status = block.is_error ? 'error' : 'success'
      this.deltas.flush()
      this.emit({
        type: 'tool-update',
        chatId: this.chat.id,
        messageId: loc.message.id,
        toolUseId: part.toolUseId,
        patch: {
          status: part.status,
          output: part.output,
          outputImages: part.outputImages,
          denied: part.denied
        }
      })
      this.flagBuriedMutation(loc.message.id)
      this.store.saveChatSoon(this.chat.id)
      // Result applied — the routing entry is dead weight now. A tool's result
      // arrives exactly once, after the assistant message that declared it (and
      // for a Task tool, after all its sub-agent traffic), so nothing reads this
      // id again. The stored ToolPart keeps its output; only the map entry goes.
      this.toolLoc.delete(block.tool_use_id)
    }
  }

  /** Locates the parent Task tool part a sub-agent's traffic belongs to. */
  private parentToolPart(parentToolUseId: string): { messageId: string; part: ToolPart } | null {
    const loc = this.toolLoc.get(parentToolUseId)
    if (!loc) return null
    const part = loc.message.parts[loc.index]
    if (part?.type !== 'tool') return null
    return { messageId: loc.message.id, part }
  }

  private emitChildUpdate(messageId: string, parent: ToolPart): void {
    this.deltas.flush()
    this.emit({
      type: 'tool-update',
      chatId: this.chat.id,
      messageId,
      toolUseId: parent.toolUseId,
      // Fresh array so the renderer's shallow compare re-renders the card.
      patch: { children: parent.children ? [...parent.children] : [] }
    })
    this.flagBuriedMutation(messageId)
    this.store.saveChatSoon(this.chat.id)
  }

  /**
   * A sub-agent's assistant turn: its text, thinking and tool calls are folded
   * into the parent Task tool's `children`. Sub-agents emit one assistant
   * message per step, so parts accumulate across calls rather than replace.
   */
  private handleSubAgentAssistant(parentToolUseId: string, msg: SDKAssistantMessage): void {
    const parent = this.parentToolPart(parentToolUseId)
    if (!parent) return
    const children = parent.part.children ?? (parent.part.children = [])
    for (const block of msg.message.content as unknown as Array<Record<string, unknown>>) {
      const type = block.type as string
      if (type === 'text') {
        const text = (block.text as string) ?? ''
        if (text) children.push({ type: 'text', text })
      } else if (type === 'thinking') {
        const text = (block.thinking as string) ?? ''
        if (text) children.push({ type: 'thinking', text })
      } else if (type === 'tool_use' || type === 'server_tool_use') {
        const toolUseId = block.id as string
        const existing = this.childToolLoc.get(toolUseId)
        const childPart: ToolPart = {
          type: 'tool',
          toolUseId,
          name: (block.name as string) ?? 'Tool',
          input: block.input,
          status: 'running'
        }
        if (existing) {
          children[existing.index] = { ...children[existing.index], ...childPart }
        } else {
          this.childToolLoc.set(toolUseId, { parent: parent.part, index: children.length })
          this.capMap(this.childToolLoc)
          children.push(childPart)
        }
      }
    }
    this.emitChildUpdate(parent.messageId, parent.part)
  }

  /** Matches a sub-agent tool result to its child tool part. */
  private handleSubAgentToolResults(parentToolUseId: string, message: { content?: unknown }): void {
    const parent = this.parentToolPart(parentToolUseId)
    if (!parent) return
    const content = message.content
    if (!Array.isArray(content)) return
    let changed = false
    for (const block of content) {
      if (block?.type !== 'tool_result') continue
      const loc = this.childToolLoc.get(block.tool_use_id)
      if (!loc?.parent.children) continue
      const part = loc.parent.children[loc.index]
      if (part?.type !== 'tool') continue
      let output = ''
      if (typeof block.content === 'string') {
        output = block.content
      } else if (Array.isArray(block.content)) {
        output = block.content
          .map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
          .filter(Boolean)
          .join('\n')
      }
      // New object reference so a memoized child card picks up the result.
      loc.parent.children[loc.index] = {
        ...part,
        output: output.length > 40_000 ? `${output.slice(0, 40_000)}\n… (truncated)` : output,
        status: block.is_error ? 'error' : 'success'
      }
      changed = true
      // A sub-agent tool's result arrives once, after its assistant block; the
      // child part now holds the output, so the routing entry is dead weight.
      this.childToolLoc.delete(block.tool_use_id)
    }
    if (changed) this.emitChildUpdate(parent.messageId, parent.part)
  }

  private markToolDenied(toolUseId: string): void {
    const loc = this.toolLoc.get(toolUseId)
    if (!loc) return
    const part = loc.message.parts[loc.index]
    if (part?.type !== 'tool') return
    part.status = 'error'
    part.denied = true
    this.emit({
      type: 'tool-update',
      chatId: this.chat.id,
      messageId: loc.message.id,
      toolUseId,
      patch: { status: 'error', denied: true }
    })
    this.flagBuriedMutation(loc.message.id)
    this.store.saveChatSoon(this.chat.id)
  }

  /**
   * Backstop bound on a toolUseId→location map. Entries are normally deleted the
   * instant a tool's result is applied, so this only trims the residue from
   * tools that never resolve. Evicts oldest-first (Map preserves insertion
   * order), so a still-pending recent entry is never the one dropped.
   */
  private capMap<V>(map: Map<string, V>): void {
    while (map.size > ClaudeSession.MAX_TOOL_LOC) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
}

// ---------- Manager ----------

/** The outgoing side of a provider switch, snapshotted as the switch applies. */
interface HandoffSnapshot {
  provider: Provider
  model?: string
}

export class ChatManager {
  private sessions = new Map<string, AgentSession>()
  private static readonly MAX_IDLE_SESSIONS = 2
  // Slash commands are the same for every chat in a folder, so cache them by cwd
  // — new chats in a known project can show the menu before their first turn.
  private commandsByCwd = new Map<string, SlashCommand[]>()
  // In-flight warmups, deduped per cwd.
  private warmups = new Map<string, Promise<SlashCommand[]>>()
  // The model list is account-level, not per chat or folder, so it's cached once
  // for the app run — same lifetime the renderer's store assumes.
  private models: ModelOption[] | null = null
  private modelWarmup: Promise<ModelOption[]> | null = null

  constructor(
    private store: Store,
    private emit: Emit,
    private preview: PreviewManager
  ) {}

  private sessionFor(chatId: string): AgentSession | null {
    const session = this.sessions.get(chatId)
    if (session && !session.dead) {
      // Map insertion order doubles as a tiny LRU.
      this.sessions.delete(chatId)
      this.sessions.set(chatId, session)
      return session
    }
    return null
  }

  private pruneIdleSessions(): void {
    const idle = [...this.sessions.entries()].filter(([, session]) => session.idle)
    while (idle.length > ChatManager.MAX_IDLE_SESSIONS) {
      const [chatId, session] = idle.shift()!
      session.dispose()
      this.sessions.delete(chatId)
    }
  }

  /** Cached commands for a folder, warming a one-shot session on a cache miss. */
  async getCommands(cwd: string, provider: Provider = 'claude'): Promise<SlashCommand[]> {
    if (!cwd) return []
    if (provider === 'codex') return CODEX_SLASH_COMMANDS
    const cached = this.commandsByCwd.get(cwd)
    if (cached) return cached
    return this.warmCommands(cwd)
  }

  /**
   * Fetches the slash-command list for a folder without a chat: it starts the
   * agent, asks for the commands, and closes — no user message is sent, so
   * there's no model turn or token cost. Result is cached and pushed to the UI.
   *
   * `supportedCommands` is a control request the SDK answers without a turn, so
   * like warmModels this must NOT wait for the `init` message: the CLI only
   * emits `init` once a turn begins, and a session that never takes one hangs
   * here forever — leaving the composer's / menu permanently empty. The setting
   * sources stay, unlike warmModels: project and local settings are exactly
   * where a folder's custom commands and skills come from.
   */
  private warmCommands(cwd: string): Promise<SlashCommand[]> {
    const inflight = this.warmups.get(cwd)
    if (inflight) return inflight
    const run = (async (): Promise<SlashCommand[]> => {
      const input = createInputQueue()
      const q = query({
        prompt: input.iterate(),
        options: {
          cwd,
          permissionMode: 'default',
          settingSources: ['user', 'project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code' }
        }
      })
      try {
        const raw = await q.supportedCommands()
        const commands: SlashCommand[] = raw.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint || undefined,
          aliases: c.aliases
        }))
        this.commandsByCwd.set(cwd, commands)
        this.emit({ type: 'commands', chatId: '', cwd, commands })
        return commands
      } catch {
        return []
      } finally {
        input.end()
        try {
          q.close()
        } catch {
          // already closed
        }
      }
    })()
    this.warmups.set(cwd, run)
    void run.finally(() => this.warmups.delete(cwd))
    return run
  }

  /**
   * Reads the model list off a throwaway agent process. `supportedModels` is a
   * control request the SDK answers without a turn, so like warmCommands this
   * never waits for the `init` message — and deliberately loads no setting
   * sources: the list is account-level, and skipping settings keeps the project's
   * SessionStart hooks (which can be slow, or stall) out of the path.
   */
  private async warmModels(cwd: string): Promise<ModelOption[]> {
    const input = createInputQueue()
    const q = query({ prompt: input.iterate(), options: { cwd } })
    try {
      return (await q.supportedModels()).map(toModelOption)
    } catch {
      return []
    } finally {
      input.end()
      try {
        q.close()
      } catch {
        // already closed
      }
    }
  }

  private createSession(chat: ChatData): AgentSession {
    const onDead = (): void => {
      if (this.sessions.get(chat.id)?.dead) this.sessions.delete(chat.id)
    }
    const sessionEmit: Emit = (event) => {
      this.emit(event)
      if (
        (event.type === 'status' && event.status === 'idle') ||
        (event.type === 'background-jobs' && event.jobs.length === 0)
      ) {
        queueMicrotask(() => this.pruneIdleSessions())
      }
    }
    const session: AgentSession =
      chat.provider === 'codex'
        ? new CodexSession(chat, sessionEmit, this.store, onDead)
        : new ClaudeSession(
            chat,
            sessionEmit,
            this.store,
            onDead,
            (commands) => this.commandsByCwd.set(chat.cwd, commands),
            this.preview
          )
    this.sessions.set(chat.id, session)
    this.pruneIdleSessions()
    return session
  }

  send(chatId: string, text: string, attachments?: Attachment[], label?: string): void {
    const chat = this.store.getChat(chatId)
    if (!chat) return
    // A pending model pick from the other provider applies now — the send is
    // the commitment; until here it was only a chip in the composer.
    const handoff = this.applyPendingSwitch(chat)
    const command = chat.provider === 'codex' ? parseCodexSlashCommand(text) : null
    if (command) {
      void this.runCodexCommand(chat, command, attachments, handoff)
      return
    }
    this.sendPrompt(chat, text, attachments, label, handoff)
  }

  /**
   * Apply a deferred cross-provider model pick. Returns the outgoing side for
   * the handoff context, or null when nothing was pending (or the pick had
   * already been cancelled by re-picking the current provider).
   */
  private applyPendingSwitch(chat: ChatData): HandoffSnapshot | null {
    const pending = chat.pendingModel
    if (pending === undefined) return null
    chat.pendingModel = undefined
    const nextProvider = providerForModel(pending)
    if (nextProvider === chat.provider) {
      // Stale pick that ended up back home — just make sure the model applies.
      chat.model = pending || undefined
      this.emit({ type: 'meta', chatId: chat.id, patch: { pendingModel: undefined, model: chat.model } })
      return null
    }
    const prevModel = chat.model
    chat.model = pending || undefined
    this.emit({ type: 'meta', chatId: chat.id, patch: { pendingModel: undefined, model: chat.model } })
    return this.switchProvider(chat, nextProvider, prevModel)
  }

  /** `modelLabel` through the live SDK list, so dynamic alias ids get real names. */
  private label(model: string | undefined, provider: Provider): string {
    return modelLabel(model, provider, this.models ?? undefined)
  }

  private sendPrompt(
    chat: ChatData,
    text: string,
    attachments?: Attachment[],
    label?: string,
    handoff?: HandoffSnapshot | null
  ): void {
    if (!handoff) {
      this.deliver(chat, text, attachments, label)
      return
    }
    // Lock the composer with a visible reason while the handoff context is
    // generated; the note clears the moment the turn reaches the new backend.
    const note =
      `Switching to ${this.label(chat.model, chat.provider)} — ` +
      `${this.label(handoff.model, handoff.provider)} is handing off the conversation…`
    chat.switchingNote = note
    this.emit({ type: 'meta', chatId: chat.id, patch: { switchingNote: note } })
    const context = this.handoffContext(chat, handoff).finally(() => {
      chat.switchingNote = undefined
      this.emit({ type: 'meta', chatId: chat.id, patch: { switchingNote: undefined } })
    })
    this.deliver(chat, text, attachments, label, context)
  }

  private deliver(
    chat: ChatData,
    text: string,
    attachments?: Attachment[],
    label?: string,
    hiddenContext?: string | Promise<string | undefined>
  ): void {
    try {
      const session = this.sessionFor(chat.id) ?? this.createSession(chat)
      session.send(text, attachments, label, hiddenContext)
    } catch (err) {
      // Session construction failed before the turn started (e.g. a missing or
      // non-executable Codex binary). Persist the prompt, surface the error, and
      // return to idle so the message isn't lost and the chat isn't stuck.
      const now = Date.now()
      const last = chat.messages[chat.messages.length - 1]
      if (!(last?.role === 'user' && last.text === text)) {
        const userMsg = {
          id: randomUUID(),
          role: 'user' as const,
          text,
          ts: now,
          ...(attachments?.length ? { attachments } : {}),
          ...(label ? { label } : {})
        }
        chat.messages.push(userMsg)
        this.emit({ type: 'message', chatId: chat.id, message: userMsg })
      }
      const errMsg = {
        id: randomUUID(),
        role: 'event' as const,
        kind: 'error' as const,
        text: err instanceof Error ? err.message : String(err),
        ts: now
      }
      chat.messages.push(errMsg)
      chat.updatedAt = now
      this.emit({ type: 'message', chatId: chat.id, message: errMsg })
      this.emit({ type: 'status', chatId: chat.id, status: 'idle' })
      this.store.saveChat(chat.id)
    }
  }

  private pushEvent(
    chat: ChatData,
    text: string,
    kind: 'info' | 'error' | 'switch' = 'info',
    switchInfo?: ModelSwitchInfo
  ): void {
    const msg = {
      id: randomUUID(),
      role: 'event' as const,
      kind,
      text,
      ts: Date.now(),
      ...(switchInfo ? { switch: switchInfo } : {})
    }
    chat.messages.push(msg)
    chat.updatedAt = msg.ts
    this.emit({ type: 'message', chatId: chat.id, message: msg })
    this.store.saveChatSoon(chat.id)
  }

  /**
   * Flip a chat to the other provider's backend (the model itself was already
   * assigned by the caller). Sessions aren't portable across backends, so the
   * live session is dropped; the returned snapshot feeds `handoffContext` so
   * the conversation carries over on the turn being sent. Null when the chat
   * has no history worth handing over.
   */
  private switchProvider(
    chat: ChatData,
    nextProvider: Provider,
    prevModel: string | undefined
  ): HandoffSnapshot | null {
    const prevProvider = chat.provider
    chat.provider = nextProvider
    chat.effort = effortForProvider(chat.effort, nextProvider)
    chat.sessionId = undefined
    const review = chat.pendingPlanReview
    chat.pendingPlanReview = undefined
    this.disposeChat(chat.id)
    const hasHistory = chat.messages.some((m) => m.role === 'user' || m.role === 'assistant')
    if (hasHistory) {
      this.pushEvent(
        chat,
        `Switching to ${this.label(chat.model, nextProvider)} — ` +
          `${this.label(prevModel, prevProvider)} is writing a handoff brief so the ` +
          'conversation continues with its context.',
        'switch',
        {
          fromModel: modelDisplayName(prevModel, prevProvider, this.models ?? undefined),
          fromProvider: prevProvider,
          toModel: modelDisplayName(chat.model, nextProvider, this.models ?? undefined),
          toProvider: nextProvider
        }
      )
    }
    if (review) {
      this.emit({ type: 'permission-resolved', chatId: chat.id, requestId: review.requestId })
    }
    this.emit({
      type: 'meta',
      chatId: chat.id,
      patch: {
        provider: nextProvider,
        sessionId: undefined,
        effort: chat.effort,
        pendingPlanReview: undefined
      }
    })
    return hasHistory ? { provider: prevProvider, model: prevModel } : null
  }

  /** The chat's loaded transcript, serialized under `cap` for the handoff. */
  private transcriptFor(chat: ChatData, cap: number): string {
    const hidden = this.store.hiddenBefore(chat.id)
    return serializeTranscript(chat.messages.slice(hidden), cap, hidden > 0)
  }

  /**
   * The hidden context for the first turn after a provider switch: the
   * outgoing model writes a handoff brief on a throwaway one-shot (never by
   * touching the original session), with the raw capped transcript as the
   * fallback when that fails or times out. Returned as a promise — the
   * session echoes the user message immediately and holds the turn until
   * this resolves.
   */
  private async handoffContext(
    chat: ChatData,
    handoff: HandoffSnapshot
  ): Promise<string | undefined> {
    // Off the send IPC tick — serialization is bounded, but not free.
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      const fromLabel = this.label(handoff.model, handoff.provider)
      const transcript = this.transcriptFor(chat, HANDOFF_TRANSCRIPT_CHARS)
      if (!transcript) return undefined
      const prompt = buildHandoffBriefPrompt(
        transcript,
        fromLabel,
        this.label(chat.model, chat.provider)
      )
      const gen =
        handoff.provider === 'codex'
          ? generateCodexText(chat.cwd, handoff.model, `${HANDOFF_BRIEF_SYSTEM}\n\n${prompt}`)
          : generateClaudeText(chat.cwd, handoff.model, HANDOFF_BRIEF_SYSTEM, prompt)
      const brief = await withTimeout(gen, HANDOFF_TIMEOUT_MS, null)
      const summary = brief ?? this.transcriptFor(chat, HANDOFF_FALLBACK_CHARS)
      return summary ? buildHandoffContext(summary, fromLabel, !brief) : undefined
    } catch (err) {
      console.error('[handoff] brief failed, delivering without context:', err)
      return undefined
    }
  }

  private pushCommandResult(
    chat: ChatData,
    commandText: string,
    text: string,
    kind: 'info' | 'error' = 'info'
  ): void {
    const user = { id: randomUUID(), role: 'user' as const, text: commandText, ts: Date.now() }
    chat.messages.push(user)
    this.emit({ type: 'message', chatId: chat.id, message: user })
    this.pushEvent(chat, text, kind)
    this.emit({ type: 'status', chatId: chat.id, status: 'idle' })
    this.store.saveChat(chat.id)
  }

  /**
   * `handoff` carries a provider switch this same send applied. Prompt-running
   * commands thread it into their turn; commands that don't start a turn drop
   * it — the switch already happened, only the brief is skipped.
   */
  private async runCodexCommand(
    chat: ChatData,
    command: NonNullable<ReturnType<typeof parseCodexSlashCommand>>,
    attachments?: Attachment[],
    handoff?: HandoffSnapshot | null
  ): Promise<void> {
    try {
      switch (command.name) {
        case 'plan': {
          await this.setOptions(chat.id, { permissionMode: 'plan' })
          if (command.argument) {
            this.sendPrompt(chat, command.argument, attachments, undefined, handoff)
          } else {
            this.pushCommandResult(
              chat,
              command.original,
              'Plan mode enabled. Send a request and Codex will prepare a reviewable plan before making changes.'
            )
          }
          return
        }

        case 'model': {
          if (!command.argument) {
            const current =
              MODEL_OPTIONS.find((model) => model.id === (chat.model ?? CODEX_DEFAULT_MODEL))?.label ??
              chat.model ??
              'Codex default'
            this.pushCommandResult(chat, command.original, `Current model: **${current}**.`)
            return
          }
          const aliases: Record<string, string> = {
            default: CODEX_DEFAULT_MODEL,
            codex: CODEX_DEFAULT_MODEL,
            sol: 'gpt-5.6-sol',
            terra: 'gpt-5.6-terra',
            luna: 'gpt-5.6-luna'
          }
          const requested = command.argument.toLowerCase()
          const modelId = aliases[requested] ?? command.argument
          const model = MODEL_OPTIONS.find((option) => option.provider === 'codex' && option.id === modelId)
          if (!model) {
            this.pushCommandResult(
              chat,
              command.original,
              'Unknown Codex model. Use `default`, `sol`, `terra`, `luna`, or an ID shown in the model picker.',
              'error'
            )
            return
          }
          await this.setOptions(chat.id, { model: model.id })
          this.pushCommandResult(chat, command.original, `Model changed to **${model.label}**.`)
          return
        }

        case 'reasoning': {
          if (!command.argument) {
            this.pushCommandResult(
              chat,
              command.original,
              `Current reasoning effort: **${chat.effort ?? 'default (Codex config)'}**.`
            )
            return
          }
          const effort = command.argument.toLowerCase()
          const model = MODEL_OPTIONS.find((option) => option.id === chat.model)
          const supported = model?.supportedEfforts ?? ['low', 'medium', 'high', 'xhigh']
          if (effort !== 'default' && !supported.includes(effort as EffortId)) {
            this.pushCommandResult(
              chat,
              command.original,
              `Unsupported reasoning effort for this model. Use ${['default', ...supported]
                .map((value) => `\`${value}\``)
                .join(', ')}.`,
              'error'
            )
            return
          }
          await this.setOptions(chat.id, {
            effort: effort === 'default' ? '' : (effort as EffortId)
          })
          this.pushCommandResult(
            chat,
            command.original,
            `Reasoning effort changed to **${effort === 'default' ? 'default (Codex config)' : effort}**.`
          )
          return
        }

        case 'fast': {
          const requested = command.argument.toLowerCase()
          if (!requested || requested === 'status') {
            this.pushCommandResult(
              chat,
              command.original,
              `Current speed: **${chat.serviceTier ?? 'standard'}**.`
            )
            return
          }
          const serviceTier =
            requested === 'on' || requested === 'fast'
              ? 'fast'
              : requested === 'off' || requested === 'standard'
                ? 'standard'
                : null
          if (!serviceTier) {
            this.pushCommandResult(
              chat,
              command.original,
              'Unknown speed setting. Use `on`, `off`, or `status`.',
              'error'
            )
            return
          }
          await this.setOptions(chat.id, { serviceTier })
          this.pushCommandResult(
            chat,
            command.original,
            `Codex speed changed to **${serviceTier}**.`
          )
          return
        }

        case 'permissions': {
          if (!command.argument) {
            this.pushCommandResult(
              chat,
              command.original,
              `Current permission mode: **${chat.permissionMode}**.`
            )
            return
          }
          const modes: Record<string, PermissionModeId> = {
            plan: 'plan',
            'read-only': 'plan',
            ask: 'default',
            default: 'default',
            workspace: 'default',
            'workspace-write': 'default',
            'accept-edits': 'acceptEdits',
            auto: 'auto',
            full: 'bypassPermissions',
            'full-access': 'bypassPermissions',
            'danger-full-access': 'bypassPermissions'
          }
          const mode = modes[command.argument.toLowerCase()]
          if (!mode) {
            this.pushCommandResult(
              chat,
              command.original,
              'Unknown permission mode. Use `plan`, `ask`, `accept-edits`, `auto`, or `full-access`.',
              'error'
            )
            return
          }
          await this.setOptions(chat.id, { permissionMode: mode })
          this.pushCommandResult(chat, command.original, `Permission mode changed to **${mode}**.`)
          return
        }

        case 'status': {
          const context =
            chat.provider === 'codex'
              ? 'Unavailable through the embedded Codex SDK'
              : chat.contextTokens != null && chat.contextWindow
              ? `${chat.contextTokens.toLocaleString()} / ${chat.contextWindow.toLocaleString()} tokens`
              : 'Not available until a turn completes'
          this.pushCommandResult(
            chat,
            command.original,
            [
              '**Codex status**',
              `- Model: ${chat.model ?? 'Codex config default'}`,
              `- Reasoning: ${chat.effort ?? 'default (Codex config)'}`,
              `- Speed: ${chat.serviceTier ?? 'standard'}`,
              `- Permissions: ${chat.permissionMode}`,
              `- Project: ${chat.cwd}`,
              `- Thread: ${chat.sessionId ?? 'Not started'}`,
              `- Context: ${context}`
            ].join('\n')
          )
          return
        }

        case 'init':
          this.sendPrompt(
            chat,
            'Create an AGENTS.md file for this project. Inspect the repository first, then write concise, practical guidance for coding agents: architecture, important commands, conventions, verification steps, and project-specific pitfalls. Do not overwrite useful existing instructions; improve them in place if AGENTS.md already exists.',
            attachments,
            undefined,
            handoff
          )
          return

        case 'review': {
          const focus = command.argument ? ` Focus especially on: ${command.argument}` : ''
          this.sendPrompt(
            chat,
            `Review the current working tree for defects, regressions, security issues, and missing tests. Do not modify any files. Report actionable findings first, ordered by severity, with file and line references.${focus}`,
            attachments,
            undefined,
            handoff
          )
        }
      }
    } catch (error) {
      this.pushCommandResult(
        chat,
        command.original,
        error instanceof Error ? error.message : String(error),
        'error'
      )
    }
  }

  /**
   * Whether a chat has a live CLI session. Introspection (MCP/models/agents/
   * account/usage) and rewind need one; a resumed session only emits `init`
   * after its first message, so we don't lazily start one just to read state —
   * the UI shows a "send a message" hint instead.
   */
  sessionLive(chatId: string): boolean {
    return this.sessionFor(chatId) !== null
  }

  async rewindFiles(chatId: string, userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    // Checkpoints live in the CLI process, so rewind needs the same live session
    // that made the edits.
    const session = this.sessionFor(chatId)
    if (!session) {
      return {
        canRewind: false,
        error: 'Rewind is only available during a running session. Send a message to start one.'
      }
    }
    return session.rewindFiles(userMessageId, dryRun)
  }

  async mcpStatus(chatId: string): Promise<McpServerInfo[]> {
    return (await this.sessionFor(chatId)?.mcpStatus()) ?? []
  }

  async mcpReconnect(chatId: string, name: string): Promise<OpResult> {
    const session = this.sessionFor(chatId)
    return session ? session.mcpReconnect(name) : { ok: false, error: 'No running session.' }
  }

  async mcpToggle(chatId: string, name: string, enabled: boolean): Promise<OpResult> {
    const session = this.sessionFor(chatId)
    return session ? session.mcpToggle(name, enabled) : { ok: false, error: 'No running session.' }
  }

  /**
   * The account's models. Prefers the chat's live session; otherwise warms a
   * throwaway one, so a chat that hasn't had a turn yet still gets the real list
   * — without it the renderer falls back to the static MODEL_OPTIONS, whose
   * "Default" row carries no `resolvedModel` and so leaves the composer chip
   * reading "Default" instead of naming the model behind it. The list is
   * account-level, so one warm-up serves every chat and every cwd; `cwd` covers
   * the new-chat screen, which has a folder but no chat yet.
   */
  async listModels(chatId: string, cwd?: string): Promise<ModelOption[]> {
    const live = await this.sessionFor(chatId)?.listModels()
    if (live?.length) return live
    if (this.models) return this.models
    const folder = this.store.getMeta(chatId)?.cwd || cwd
    if (!folder) return []
    this.modelWarmup ??= this.warmModels(folder)
      .then((options) => {
        // An empty list means the agent never started, not an account with no
        // models — leave the cache unset so the next caller retries.
        if (options.length) this.models = options
        return options
      })
      .finally(() => {
        this.modelWarmup = null
      })
    return this.modelWarmup
  }

  async listAgents(chatId: string): Promise<AgentInfo[]> {
    return (await this.sessionFor(chatId)?.listAgents()) ?? []
  }

  async accountInfo(chatId: string): Promise<AccountInfo | null> {
    return (await this.sessionFor(chatId)?.accountInfo()) ?? null
  }

  async usageInfo(chatId: string): Promise<UsageInfo | null> {
    return (await this.sessionFor(chatId)?.usageInfo()) ?? null
  }

  async interrupt(chatId: string): Promise<void> {
    const session = this.sessionFor(chatId)
    if (session) {
      await session.interrupt()
      return
    }
    // A persisted Codex plan can be waiting without a live SDK wrapper after an
    // app restart. Stopping it should still dismiss the review cleanly.
    const chat = this.store.getChat(chatId)
    const review = chat?.provider === 'codex' ? chat.pendingPlanReview : undefined
    if (!chat || !review) return
    chat.pendingPlanReview = undefined
    this.store.saveChat(chatId)
    this.emit({ type: 'permission-resolved', chatId, requestId: review.requestId })
    this.emit({ type: 'meta', chatId, patch: { pendingPlanReview: undefined } })
    this.emit({ type: 'status', chatId, status: 'idle' })
  }

  async stopBackgroundJob(chatId: string, taskId: string): Promise<void> {
    await this.sessionFor(chatId)?.stopBackgroundJob(taskId)
  }

  respondPermission(chatId: string, requestId: string, decision: PermissionDecision): void {
    const chat = this.store.getChat(chatId)
    // A plan approved with the *other* provider's "Build with" model never
    // reaches the session that wrote it — the manager tears the review down
    // and hands implementation across the backend boundary instead.
    if (
      chat &&
      decision.behavior === 'allow' &&
      decision.model !== undefined &&
      providerForModel(decision.model) !== chat.provider
    ) {
      const plan = this.planForRequest(chat, requestId)
      if (plan !== null) {
        this.approvePlanCrossProvider(chat, decision, plan)
        return
      }
    }
    const live = this.sessionFor(chatId)
    if (live) {
      live.respondPermission(requestId, decision)
      return
    }
    // Codex plan reviews are persisted. Recreate the lightweight thread wrapper
    // on demand so an approval made after an app restart can still continue.
    if (chat?.provider === 'codex' && chat.pendingPlanReview?.requestId === requestId) {
      this.createSession(chat).respondPermission(requestId, decision)
    }
  }

  /** The plan text behind a pending review request, if `requestId` is one. */
  private planForRequest(chat: ChatData, requestId: string): string | null {
    if (chat.provider === 'codex') {
      return chat.pendingPlanReview?.requestId === requestId ? chat.pendingPlanReview.plan : null
    }
    // Claude's review is a live ExitPlanMode permission; it dies with the
    // session, so a live session is the only place it can be pending.
    return this.sessionFor(chat.id)?.pendingPlan?.(requestId) ?? null
  }

  /**
   * Approve a plan into the other provider: restore the pre-plan permission
   * mode, switch backends (disposing the plan session resolves its pending
   * review; `switchProvider` stashes the handoff), and kick off implementation
   * with the plan text verbatim — the plan itself is the handoff artifact, the
   * generated brief only covers the conversation around it.
   */
  private approvePlanCrossProvider(
    chat: ChatData,
    decision: Extract<PermissionDecision, { behavior: 'allow' }>,
    plan: string
  ): void {
    const nextProvider = providerForModel(decision.model!)
    const fromLabel = this.label(chat.model, chat.provider)
    // Same restore rule as the in-provider approvals: back to the mode the
    // chat was in before plan mode, with 'default' for a chat *created* in
    // plan mode — never read-only for the work it just approved.
    const restore = chat.modeBeforePlan ?? 'default'
    chat.modeBeforePlan = undefined
    if (restore !== 'plan') chat.permissionMode = restore
    if (decision.effort !== undefined) {
      chat.effort = effortForProvider(decision.effort || undefined, nextProvider)
    }
    const prevModel = chat.model
    chat.model = decision.model || undefined
    chat.pendingModel = undefined
    const handoff = this.switchProvider(chat, nextProvider, prevModel)
    this.emit({
      type: 'meta',
      chatId: chat.id,
      patch: {
        model: chat.model,
        pendingModel: undefined,
        permissionMode: chat.permissionMode,
        modeBeforePlan: undefined
      }
    })
    this.store.saveChat(chat.id)
    this.sendPrompt(
      chat,
      buildPlanImplementPrompt(plan, fromLabel),
      undefined,
      'Implement the plan',
      handoff
    )
  }

  async setOptions(
    chatId: string,
    patch: ChatOptionsPatch
  ): Promise<void> {
    const chat = this.store.getChat(chatId)
    if (!chat) return
    const session = this.sessionFor(chatId)
    if (patch.model !== undefined) {
      if (providerForModel(patch.model) !== chat.provider) {
        // Crossing providers has real side effects (session teardown, a
        // handoff brief), so a pick only *arms* the switch — it applies on
        // the next send (see applyPendingSwitch). A misclick costs nothing.
        chat.pendingModel = patch.model
      } else {
        // Picking back into the current provider cancels any armed switch.
        chat.pendingModel = undefined
        chat.model = patch.model || undefined
        await session?.setModel(chat.model)
      }
    }
    if (patch.permissionMode) {
      // Remember what to come back to when the plan is approved.
      if (patch.permissionMode === 'plan' && chat.permissionMode !== 'plan') {
        chat.modeBeforePlan = chat.permissionMode
      } else if (patch.permissionMode !== 'plan') {
        chat.modeBeforePlan = undefined
      }
      chat.permissionMode = patch.permissionMode
      await session?.setPermissionMode(patch.permissionMode)
      if (!session && patch.permissionMode !== 'plan' && chat.pendingPlanReview) {
        const { requestId } = chat.pendingPlanReview
        chat.pendingPlanReview = undefined
        this.emit({ type: 'permission-resolved', chatId, requestId })
      }
    }
    if (patch.effort !== undefined && (patch.effort || undefined) !== chat.effort) {
      chat.effort = effortForProvider(patch.effort || undefined, chat.provider)
      // Effort has no live setter — drop the session; the next send resumes
      // the conversation in a fresh process with the new effort applied.
      if (session) {
        this.disposeChat(chatId)
        // Same as the provider switch: the disposed session won't emit a final
        // status, so release the renderer in case the change landed mid-turn.
        this.emit({
          type: 'status',
          chatId,
          status: chat.pendingPlanReview ? 'waiting-permission' : 'idle'
        })
      }
    }
    if (patch.serviceTier !== undefined && patch.serviceTier !== chat.serviceTier) {
      chat.serviceTier = patch.serviceTier
      // Claude can change this flag live; Codex's client-level config requires
      // a fresh wrapper, which resumes the same provider thread on the next turn.
      if (session && chat.provider === 'claude' && session.setServiceTier) {
        await session.setServiceTier(patch.serviceTier)
      } else if (session) {
        this.disposeChat(chatId)
        this.emit({
          type: 'status',
          chatId,
          status: chat.pendingPlanReview ? 'waiting-permission' : 'idle'
        })
      }
    }
    this.store.saveChat(chatId)
    // Explicit user choices become the defaults for future chats — but a patch
    // the app generated to correct an unsupported value is not one, so it stays
    // scoped to this chat.
    if (patch.remember !== false) this.store.rememberOptions(patch, chat.model)
    this.emit({
      type: 'meta',
      chatId,
      patch: {
        model: chat.model,
        pendingModel: chat.pendingModel,
        effort: chat.effort,
        serviceTier: chat.serviceTier,
        permissionMode: chat.permissionMode,
        pendingPlanReview: chat.pendingPlanReview
      }
    })
  }

  /**
   * Move a chat to a new working directory (the worktree hand-off). The live
   * session has its cwd baked in, so it's dropped and the next send respawns
   * there — the same mechanism an effort change uses.
   *
   * Whether the resume id survives the move is provider knowledge, so it's
   * decided here rather than at the IPC handler: Claude files each conversation
   * under a directory derived from its cwd, so an id earned in the worktree is
   * unfindable from the main checkout and every later send would fail with
   * "No conversation found with session ID". Codex resumes by thread id and
   * files rollouts by date, so its id stays valid.
   */
  relocateChat(chatId: string, cwd: string): void {
    const chat = this.store.getChat(chatId)
    if (!chat) return
    this.disposeChat(chatId)
    chat.cwd = cwd
    chat.worktree = undefined
    if (chat.provider !== 'codex') chat.sessionId = undefined
    this.store.saveChat(chatId)
    this.emit({
      type: 'meta',
      chatId,
      patch: { cwd, worktree: undefined, sessionId: chat.sessionId }
    })
    // A disposed session emits no final status; release the renderer so a
    // hand-off during a live turn doesn't leave the chat stuck 'streaming'.
    this.emit({ type: 'status', chatId, status: 'idle' })
  }

  disposeChat(chatId: string): void {
    this.sessions.get(chatId)?.dispose()
    this.sessions.delete(chatId)
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
  }
}
