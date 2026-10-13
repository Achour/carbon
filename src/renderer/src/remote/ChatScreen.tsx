import * as React from 'react'
import {
  Bot,
  ChartColumn,
  ChevronRight,
  ClipboardList,
  FilePen,
  FilePlus2,
  FileText,
  FolderSearch,
  GitBranch,
  Globe,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  MonitorPlay,
  PanelsTopLeft,
  Play,
  Search,
  SquareTerminal,
  TriangleAlert,
  Workflow,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type {
  AssistantPart,
  ChatMessage,
  ChatMeta,
  EventMessage,
  ToolPart,
  UserMessage
} from '@shared/types'
import { PROVIDER_LABELS, modelDisplayName } from '@shared/types'
import { leadActivityLabel, summarizeActivity } from '@/lib/toolSummary'
import { cn } from '@/lib/utils'
import { useRemote } from './state'
import { Header } from './App'
import { chatTitle, duration, isBusy, projectName, toolLine } from './format'
import { RemoteMarkdown } from './Markdown'
import { Composer } from './Composer'
import { OptionChips } from './OptionChips'
import { useAllModels, type OptionValues } from './options'
import { PermissionCard } from './PermissionCard'

/** A run this long folds into one summary row, as the desktop's `ToolGroup` does. */
const GROUP_AT = 3

type Block =
  | { kind: 'user'; key: string; message: UserMessage }
  | { kind: 'event'; key: string; message: EventMessage }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tools'; key: string; parts: ToolPart[] }

/**
 * The transcript as blocks: a run of tool calls is one block even when it
 * spans several assistant messages (Claude sends one call per message), and a
 * withheld thought is transparent to it — the same grouping the desktop draws.
 */
function toBlocks(messages: ChatMessage[]): Block[] {
  const out: Block[] = []
  for (const m of messages) {
    if (m.role === 'user') out.push({ kind: 'user', key: m.id, message: m })
    else if (m.role === 'event') out.push({ kind: 'event', key: m.id, message: m })
    else if (m.role === 'assistant') {
      m.parts.forEach((p: AssistantPart | undefined, i) => {
        if (!p) return
        const key = `${m.id}:${i}`
        if (p.type === 'text') {
          if (p.text.trim()) out.push({ kind: 'text', key, text: p.text })
        } else if (p.type === 'thinking') {
          if (p.text.trim()) out.push({ kind: 'thinking', key, text: p.text })
        } else {
          const last = out[out.length - 1]
          if (last?.kind === 'tools') last.parts.push(p)
          else out.push({ kind: 'tools', key, parts: [p] })
        }
      })
    }
  }
  return out
}

export function ChatScreen({ chatId }: { chatId: string }): React.JSX.Element {
  const chat = useRemote((s) => s.chats.find((c) => c.id === chatId))
  const open = useRemote((s) => (s.open?.id === chatId ? s.open : null))
  const status = useRemote((s) => s.statuses[chatId])
  const requests = useRemote((s) => s.permissions[chatId])
  const queued = useRemote((s) => s.queued[chatId]?.length ?? 0)
  const loadOlder = useRemote((s) => s.loadOlder)
  const setOptions = useRemote((s) => s.setOptions)
  const busy = isBusy(status)
  const blocks = React.useMemo(() => toBlocks(open?.messages ?? []), [open?.messages])

  const scroller = React.useRef<HTMLDivElement>(null)
  // Follow the bottom while the reader is there; leave them be once they scroll up.
  const pinned = React.useRef(true)
  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 400 && open && open.hiddenBefore > 0 && !open.loading) {
      // Earlier messages, anchored on the distance from the bottom so the
      // prepend does not move what is being read.
      const fromBottom = el.scrollHeight - el.scrollTop
      void loadOlder().then(() =>
        requestAnimationFrame(() => {
          if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight - fromBottom
        })
      )
    }
  }
  React.useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })

  const values: OptionValues | null = chat
    ? {
        provider: chat.pendingProvider ?? chat.provider,
        model: chat.pendingModel ?? chat.model ?? '',
        effort: chat.effort ?? '',
        serviceTier: chat.serviceTier ?? 'standard',
        permissionMode: chat.permissionMode ?? 'default'
      }
    : null

  return (
    <div className="flex h-full flex-col">
      <Header
        title={chat ? chatTitle(chat) : 'Chat'}
        subtitle={chat ? `${projectName(chat)}${chat.worktree ? ` · ${chat.worktree.branch}` : ''}` : undefined}
      />
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2 pb-4">
        {open && open.hiddenBefore > 0 && (
          <div className="flex justify-center py-2 text-muted-foreground">
            {open.loading ? <Loader2 className="size-4 animate-spin" /> : <span className="text-[13px]">Scroll up for earlier messages</span>}
          </div>
        )}
        {!open || (open.loading && open.messages.length === 0) ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : blocks.length === 0 ? (
          <div className="py-16 text-center text-[15px] text-muted-foreground">No messages yet.</div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {blocks.map((b) => (
              <BlockView key={b.key} block={b} cwd={chat?.cwd ?? ''} />
            ))}
          </div>
        )}
        {busy && (
          <div className="mt-4 flex items-center gap-2 text-[14.5px]">
            <span className={status === 'waiting-permission' ? 'text-warning' : 'shimmer-text'}>
              {status === 'waiting-permission' ? 'Waiting for you' : 'Working…'}
            </span>
          </div>
        )}
      </div>
      {requests?.length ? (
        <div className="flex max-h-[60dvh] shrink-0 flex-col gap-2 overflow-y-auto px-3 pt-1">
          {requests.map((r) => (
            <PermissionCard key={r.id} chatId={chatId} request={r} provider={chat?.provider ?? 'claude'} />
          ))}
        </div>
      ) : null}
      <Composer
        chatId={chatId}
        busy={busy}
        queued={queued}
        above={chat?.pendingModel !== undefined && chat.pendingProvider ? <PendingSwitch chat={chat} /> : null}
        tools={
          values && (
            <OptionChips
              values={values}
              onChange={(patch, remember) =>
                void setOptions(chatId, {
                  ...(patch.model !== undefined ? { model: patch.model, modelProvider: patch.provider } : {}),
                  ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
                  ...(patch.serviceTier !== undefined ? { serviceTier: patch.serviceTier } : {}),
                  ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
                  remember
                })
              }
            />
          )
        }
      />
    </div>
  )
}

/** A cross-provider pick is armed, not applied — say so, and offer the way back. */
function PendingSwitch({ chat }: { chat: ChatMeta }): React.JSX.Element {
  const all = useAllModels()
  const setOptions = useRemote((s) => s.setOptions)
  const to = chat.pendingProvider!
  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl bg-muted px-3 py-2 text-[13px] text-muted-foreground">
      <span className="min-w-0 flex-1">
        Switches to <span className="text-foreground">{modelDisplayName(chat.pendingModel, to, all)}</span> (
        {PROVIDER_LABELS[to]}) when you send — the conversation is handed over.
      </span>
      <button
        type="button"
        className="shrink-0 font-medium text-foreground"
        onClick={() =>
          void setOptions(chat.id, { model: chat.model ?? '', modelProvider: chat.provider, remember: false })
        }
      >
        Undo
      </button>
    </div>
  )
}

const BlockView = React.memo(function BlockView({ block, cwd }: { block: Block; cwd: string }) {
  switch (block.kind) {
    case 'user':
      return <UserBubble message={block.message} />
    case 'event':
      return <EventLine message={block.message} />
    case 'text':
      return <RemoteMarkdown text={block.text} />
    case 'thinking':
      return <Thinking text={block.text} />
    case 'tools':
      return block.parts.length >= GROUP_AT ? <ToolGroup parts={block.parts} cwd={cwd} /> : (
        <div className="flex flex-col gap-0.5">
          {block.parts.map((p) => (
            <ToolRow key={p.toolUseId} part={p} cwd={cwd} />
          ))}
        </div>
      )
  }
})

function UserBubble({ message }: { message: UserMessage }): React.JSX.Element {
  const images = message.attachments?.filter((a) => a.kind === 'image' && a.data) ?? []
  const others = message.attachments?.filter((a) => a.kind !== 'image') ?? []
  const text = message.label ?? message.text
  return (
    <div className="flex flex-col items-end gap-1.5 pt-2">
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((a) => (
            <img
              key={a.id}
              src={`data:${a.mediaType};base64,${a.data}`}
              alt={a.name}
              className="max-h-40 max-w-[70%] rounded-2xl border border-border object-cover"
            />
          ))}
        </div>
      )}
      {text && (
        <div className="max-w-[88%] rounded-[20px] border border-border bg-card px-4 py-2.5 text-[15.5px] leading-[1.5] break-words whitespace-pre-wrap select-text">
          {text}
        </div>
      )}
      {others.length > 0 && <div className="text-[12.5px] text-muted-foreground">{others.map((a) => a.name).join(', ')}</div>}
    </div>
  )
}

function EventLine({ message }: { message: EventMessage }): React.JSX.Element | null {
  if (message.kind === 'turn') {
    const s = message.stats
    if (!s) return null
    return (
      <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
        <span>
          Worked for {duration(s.durationMs)}
          {s.costUsd > 0 ? ` · $${s.costUsd.toFixed(2)}` : ''}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }
  if (message.kind === 'error') {
    return (
      <div className="flex gap-3 rounded-2xl border border-destructive/35 bg-destructive/[0.07] px-4 py-3">
        <TriangleAlert className="mt-0.5 size-[18px] shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="text-[14.5px] font-medium text-destructive">Something went wrong</div>
          <div className="mt-0.5 text-[13.5px] break-words text-muted-foreground select-text">{message.text}</div>
        </div>
      </div>
    )
  }
  return <div className="text-center text-[13px] text-muted-foreground">{message.text}</div>
}

function Thinking({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[14px] text-muted-foreground">
        Thought <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-1.5 animate-in border-l-2 border-border pl-3 text-[14px] leading-relaxed whitespace-pre-wrap text-muted-foreground fade-in">
          {text}
        </div>
      )}
    </div>
  )
}

const ICONS: Record<string, LucideIcon> = {
  Terminal: SquareTerminal,
  Run: Play,
  Git: GitBranch,
  Read: FileText,
  Edit: FilePen,
  Write: FilePlus2,
  Search,
  'Find files': FolderSearch,
  'List files': FolderSearch,
  List: FolderSearch,
  Fetch: Globe,
  'Web search': Globe,
  Browser: Globe,
  Agent: Bot,
  Tasks: ListChecks,
  Plan: ClipboardList,
  Question: MessageCircleQuestion,
  Canvas: PanelsTopLeft,
  Chart: ChartColumn,
  Diagram: Workflow,
  Preview: MonitorPlay
}

function iconFor(label: string): LucideIcon {
  return ICONS[label] ?? Wrench
}

function ToolGroup({ parts, cwd }: { parts: ToolPart[]; cwd: string }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const running = parts.some((p) => p.status === 'running' || p.status === 'pending')
  const labels = parts.map((p) => toolLine(p, cwd).label)
  const Icon = iconFor(leadActivityLabel(labels) ?? '')
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-1 text-left text-[14.5px] text-muted-foreground"
      >
        <Icon className="size-4 shrink-0 opacity-70" />
        <span className={cn('min-w-0 truncate', running && 'shimmer-text')}>{summarizeActivity(labels, running)}</span>
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="ml-[7px] flex animate-in flex-col gap-0.5 border-l border-border pl-3 fade-in">
          {parts.map((p) => (
            <ToolRow key={p.toolUseId} part={p} cwd={cwd} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolRow({ part, cwd }: { part: ToolPart; cwd: string }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const { label, detail } = toolLine(part, cwd)
  const running = part.status === 'running' || part.status === 'pending'
  const failed = part.status === 'error' || part.denied
  const Icon = iconFor(label)
  const children = part.children?.filter((c): c is ToolPart => c?.type === 'tool')
  const hasBody = !!part.output || !!children?.length
  return (
    <div>
      <button
        type="button"
        onClick={() => hasBody && setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 py-1 text-left text-[14.5px]"
      >
        {running ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Icon className={cn('size-4 shrink-0', failed ? 'text-destructive' : 'text-muted-foreground opacity-70')} />
        )}
        <span className={cn('shrink-0', running ? 'shimmer-text' : 'text-muted-foreground')}>{label}</span>
        {detail && <span className="min-w-0 truncate font-mono text-[12.5px] text-muted-foreground/70">{detail}</span>}
        {part.denied && <span className="shrink-0 text-[12.5px] text-destructive">denied</span>}
        {hasBody && (
          <ChevronRight className={cn('ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        )}
      </button>
      {open && (
        <div className="mt-1 mb-1.5 animate-in fade-in">
          {children?.length ? (
            <div className="mb-1.5 ml-[7px] flex flex-col gap-0.5 border-l border-border pl-3">
              {children.map((c) => (
                <ToolRow key={c.toolUseId} part={c} cwd={cwd} />
              ))}
            </div>
          ) : null}
          {part.output && (
            <pre className="max-h-72 overflow-auto rounded-xl bg-code p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground select-text">
              {part.output.length > 8000 ? `${part.output.slice(0, 8000)}\n…` : part.output}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
