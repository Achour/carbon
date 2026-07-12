import { randomUUID } from 'node:crypto'
import {
  createSdkMcpServer,
  query,
  tool,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type {
  AssistantMessage,
  AssistantPart,
  Attachment,
  ChatData,
  ChatEvent,
  ChatStatus,
  EffortId,
  ElementRef,
  PermissionDecision,
  PermissionModeId,
  SlashCommand,
  ToolPart
} from '@shared/types'
import type { Store } from './store'
import type { PreviewManager } from './preview'

type Emit = (ev: ChatEvent) => void

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

class ClaudeSession {
  private q: Query
  private input = createInputQueue()
  private current: AssistantMessage | null = null
  private jsonAcc = new Map<number, string>()
  private toolLoc = new Map<string, { message: AssistantMessage; index: number }>()
  // Sub-agent tool calls live inside a parent Task tool's `children`, not a
  // message's parts — so they need their own location map for result matching.
  private childToolLoc = new Map<string, { parent: ToolPart; index: number }>()
  private pending = new Map<string, PendingPermission>()
  private initModel?: string
  /** Exact model name of the most recent assistant turn; keys into modelUsage. */
  private lastTurnModel?: string
  private deltaBuf = new Map<string, { messageId: string; partIndex: number; text: string }>()
  private flushTimer: NodeJS.Timeout | null = null
  dead = false

  constructor(
    private chat: ChatData,
    private emit: Emit,
    private store: Store,
    private onDead: () => void,
    private onCommands: (commands: SlashCommand[]) => void,
    private preview: PreviewManager
  ) {
    this.q = query({
      prompt: this.input.iterate(),
      options: {
        cwd: chat.cwd,
        resume: chat.sessionId,
        model: chat.model || undefined,
        effort: chat.effort || undefined,
        permissionMode: chat.permissionMode,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
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
   * Streaming deltas are coalesced for ~40ms before being sent over IPC —
   * per-token renders make long thinking phases feel like the UI hangs.
   */
  private queueDelta(messageId: string, partIndex: number, delta: string): void {
    const key = `${messageId}:${partIndex}`
    const buffered = this.deltaBuf.get(key)
    if (buffered) buffered.text += delta
    else this.deltaBuf.set(key, { messageId, partIndex, text: delta })
    this.flushTimer ??= setTimeout(() => this.flushDeltas(), 40)
    this.store.saveChatSoon(this.chat.id)
  }

  private flushDeltas(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    for (const { messageId, partIndex, text } of this.deltaBuf.values()) {
      this.emit({ type: 'part-delta', chatId: this.chat.id, messageId, partIndex, delta: text })
    }
    this.deltaBuf.clear()
  }

  private pushMessage(message: ChatData['messages'][number]): void {
    this.flushDeltas()
    this.chat.messages.push(message)
    this.chat.updatedAt = Date.now()
    this.emit({ type: 'message', chatId: this.chat.id, message })
    this.store.saveChatSoon(this.chat.id)
  }

  send(text: string, attachments: Attachment[] = []): void {
    if (!this.chat.title) {
      const title = text || attachments.map((a) => a.name).join(', ')
      this.chat.title = title.replace(/\s+/g, ' ').trim().slice(0, 64)
      this.emit({ type: 'meta', chatId: this.chat.id, patch: { title: this.chat.title } })
    }
    this.pushMessage({
      id: randomUUID(),
      role: 'user',
      text,
      ts: Date.now(),
      ...(attachments.length ? { attachments } : {})
    })
    this.emit({ type: 'meta', chatId: this.chat.id, patch: { updatedAt: this.chat.updatedAt } })
    this.setStatus(this.chat.sessionId ? 'streaming' : 'starting')

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
    let prompt = text
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
      parent_tool_use_id: null
    } as unknown as SDKUserMessage)
  }

  async interrupt(): Promise<void> {
    this.denyAllPending(true)
    try {
      await this.q.interrupt()
    } catch (err) {
      console.error('interrupt failed:', err)
    }
    this.setStatus('idle')
  }

  async setModel(model?: string): Promise<void> {
    try {
      await this.q.setModel(model || undefined)
    } catch (err) {
      console.error('setModel failed:', err)
    }
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    try {
      await this.q.setPermissionMode(mode)
    } catch (err) {
      console.error('setPermissionMode failed:', err)
    }
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    this.emit({ type: 'permission-resolved', chatId: this.chat.id, requestId })
    if (decision.behavior === 'allow') {
      pending.resolve({
        behavior: 'allow',
        updatedInput: decision.updatedInput ?? pending.input,
        updatedPermissions:
          decision.always && pending.suggestions?.length ? pending.suggestions : undefined
      })
      // Approving a plan returns to the mode the chat was in before plan
      // mode — unless the user opted into auto-accepting edits, which the
      // suggestions switch to acceptEdits themselves.
      if (pending.toolName === 'ExitPlanMode') {
        const restore = this.chat.modeBeforePlan
        this.chat.modeBeforePlan = undefined
        if (restore && restore !== 'plan' && !decision.always) {
          this.chat.permissionMode = restore
          this.emit({ type: 'meta', chatId: this.chat.id, patch: { permissionMode: restore } })
          void this.setPermissionMode(restore)
        }
        this.store.saveChatSoon(this.chat.id)
      }
      this.setStatus('streaming')
    } else {
      this.markToolDenied(pending.toolUseId)
      pending.resolve({
        behavior: 'deny',
        message: decision.message || 'The user denied this request.',
        interrupt: false
      })
      this.setStatus('streaming')
    }
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
    this.dead = true
    this.flushDeltas()
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
      if (!this.dead) {
        this.pushMessage({
          id: randomUUID(),
          role: 'event',
          kind: 'error',
          text: err instanceof Error ? err.message : String(err),
          ts: Date.now()
        })
      }
    } finally {
      this.dead = true
      this.denyAllPending(false)
      this.setStatus('idle')
      this.store.saveChat(this.chat.id)
      this.onDead()
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.initModel = msg.model
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

      case 'stream_event': {
        if (msg.parent_tool_use_id) break
        this.handleStreamEvent(msg.event)
        break
      }

      case 'assistant':
        if (msg.parent_tool_use_id) this.handleSubAgentAssistant(msg.parent_tool_use_id, msg)
        else this.reconcileAssistant(msg)
        break

      case 'user':
        if (msg.parent_tool_use_id) this.handleSubAgentToolResults(msg.parent_tool_use_id, msg.message)
        else this.handleToolResults(msg.message)
        break

      case 'result': {
        if ('modelUsage' in msg && msg.modelUsage) {
          // modelUsage is cumulative across the (resumed) session and keyed by
          // model name, so after switching models it holds an entry per model
          // used. Take the window of the model that produced this turn — not the
          // max, which would stick to the largest window ever seen (e.g. 1M)
          // after switching down to a smaller model like Sonnet.
          const current =
            this.lastTurnModel && msg.modelUsage[this.lastTurnModel]?.contextWindow
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
          const errors = 'errors' in msg && msg.errors.length ? msg.errors.join('\n') : msg.subtype
          this.pushMessage({
            id: randomUUID(),
            role: 'event',
            kind: 'error',
            text: errors,
            ts: Date.now(),
            stats
          })
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
    this.flushDeltas()
    this.emit({
      type: 'part',
      chatId: this.chat.id,
      messageId: message.id,
      partIndex: index,
      part: message.parts[index]
    })
    this.store.saveChatSoon(this.chat.id)
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
          this.queueDelta(message.id, index, delta.text ?? '')
        } else if (delta.type === 'thinking_delta' && part.type === 'thinking') {
          part.text += delta.thinking ?? ''
          this.queueDelta(message.id, index, delta.thinking ?? '')
        } else if (delta.type === 'input_json_delta') {
          this.jsonAcc.set(index, (this.jsonAcc.get(index) ?? '') + (delta.partial_json ?? ''))
        }
        break
      }

      case 'content_block_stop': {
        const message = this.current
        if (!message) break
        const index = event.index ?? -1
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
    const parts: AssistantPart[] = []
    for (const block of msg.message.content as unknown as Array<Record<string, unknown>>) {
      const type = block.type as string
      if (type === 'text') {
        parts.push({ type: 'text', text: (block.text as string) ?? '' })
      } else if (type === 'thinking') {
        parts.push({ type: 'thinking', text: (block.thinking as string) ?? '' })
      } else if (type === 'redacted_thinking') {
        parts.push({ type: 'thinking', text: '[Thinking redacted]' })
      } else if (type === 'tool_use' || type === 'server_tool_use') {
        const toolUseId = block.id as string
        const existing = this.toolLoc.get(toolUseId)?.message.parts[
          this.toolLoc.get(toolUseId)!.index
        ] as ToolPart | undefined
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
    if (parts.length > 0) {
      message.parts = parts
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        if (part.type === 'tool') this.toolLoc.set(part.toolUseId, { message, index: i })
      }
      this.flushDeltas()
      this.emit({ type: 'message', chatId: this.chat.id, message })
    }
    this.chat.updatedAt = Date.now()
    this.store.saveChatSoon(this.chat.id)
    this.current = null
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
      this.flushDeltas()
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
      this.store.saveChatSoon(this.chat.id)
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
    this.flushDeltas()
    this.emit({
      type: 'tool-update',
      chatId: this.chat.id,
      messageId,
      toolUseId: parent.toolUseId,
      // Fresh array so the renderer's shallow compare re-renders the card.
      patch: { children: parent.children ? [...parent.children] : [] }
    })
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
    this.store.saveChatSoon(this.chat.id)
  }
}

// ---------- Manager ----------

export class ChatManager {
  private sessions = new Map<string, ClaudeSession>()
  // Slash commands are the same for every chat in a folder, so cache them by cwd
  // — new chats in a known project can show the menu before their first turn.
  private commandsByCwd = new Map<string, SlashCommand[]>()
  // In-flight warmups, deduped per cwd.
  private warmups = new Map<string, Promise<SlashCommand[]>>()

  constructor(
    private store: Store,
    private emit: Emit,
    private preview: PreviewManager
  ) {}

  private sessionFor(chatId: string): ClaudeSession | null {
    const session = this.sessions.get(chatId)
    if (session && !session.dead) return session
    return null
  }

  /** Cached commands for a folder, warming a one-shot session on a cache miss. */
  async getCommands(cwd: string): Promise<SlashCommand[]> {
    if (!cwd) return []
    const cached = this.commandsByCwd.get(cwd)
    if (cached) return cached
    return this.warmCommands(cwd)
  }

  /**
   * Fetches the slash-command list for a folder without a chat: it starts the
   * agent, reads the commands at init, and closes — no user message is sent, so
   * there's no model turn or token cost. Result is cached and pushed to the UI.
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
        for await (const msg of q) {
          if (msg.type === 'system' && msg.subtype === 'init') {
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
          }
        }
        return []
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

  send(chatId: string, text: string, attachments?: Attachment[]): void {
    const chat = this.store.getChat(chatId)
    if (!chat) return
    let session = this.sessionFor(chatId)
    if (!session) {
      session = new ClaudeSession(
        chat,
        this.emit,
        this.store,
        () => {
          if (this.sessions.get(chatId)?.dead) this.sessions.delete(chatId)
        },
        (commands) => this.commandsByCwd.set(chat.cwd, commands),
        this.preview
      )
      this.sessions.set(chatId, session)
    }
    session.send(text, attachments)
  }

  async interrupt(chatId: string): Promise<void> {
    await this.sessionFor(chatId)?.interrupt()
  }

  respondPermission(chatId: string, requestId: string, decision: PermissionDecision): void {
    this.sessionFor(chatId)?.respondPermission(requestId, decision)
  }

  async setOptions(
    chatId: string,
    patch: { model?: string; effort?: EffortId | ''; permissionMode?: PermissionModeId }
  ): Promise<void> {
    const chat = this.store.getChat(chatId)
    if (!chat) return
    const session = this.sessionFor(chatId)
    if (patch.model !== undefined) {
      chat.model = patch.model || undefined
      await session?.setModel(chat.model)
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
    }
    if (patch.effort !== undefined && (patch.effort || undefined) !== chat.effort) {
      chat.effort = patch.effort || undefined
      // Effort has no live setter — drop the session; the next send resumes
      // the conversation in a fresh process with the new effort applied.
      if (session) this.disposeChat(chatId)
    }
    this.store.saveChat(chatId)
    // Explicit user choices become the defaults for future chats.
    this.store.rememberOptions(patch)
    this.emit({
      type: 'meta',
      chatId,
      patch: { model: chat.model, effort: chat.effort, permissionMode: chat.permissionMode }
    })
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
