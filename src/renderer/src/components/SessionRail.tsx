import * as React from 'react'
import { ArrowDown, ArrowUp, FileDiff, Folder, GitBranch, Laptop, Split } from 'lucide-react'
import type { ChatMeta } from '@shared/types'
import { PROVIDER_SHORT_LABELS } from '@shared/types'
import { useApp } from '@/store'
import { basename, formatTokens } from '@/lib/format'
import { cn } from '@/lib/utils'
import { GitActionButton } from '@/components/GitPanel'
import { PanelLaunchList } from '@/components/PanelActions'

/**
 * The chat's own state, kept beside it while it runs: where it works, how full
 * its context is, what it has changed, and what the panel can open. Pinned and
 * unpinned from the thread's top bar (`quickRail`). Each block is a card of the
 * depth system (`docs/depth.md`), so it reads as the same furniture as
 * Settings and the panel rather than a new kind of surface.
 */
export function SessionRail({ chat: thread }: { chat: ChatMeta }): React.JSX.Element {
  // The focused column's chat, subscribed here rather than in `ThreadView` so a
  // side chat's meta changing re-renders the rail and not every column.
  const chat = useApp((s) => {
    const id = s.focusedChatId
    return (id && s.chats.find((c) => c.id === id)) || thread
  })
  const ref = React.useRef<HTMLElement>(null)
  // With the panel open, or too little width beside the chat, there is no room
  // to give: the chat would be squeezed. The rail floats over the chat's right
  // edge instead, only as tall as its cards, and drops the launch card when the
  // panel is up, since the panel already is that list.
  const panelOpen = useApp((s) => s.panelOpen)
  const narrow = useNarrow(ref)
  const floating = panelOpen || narrow
  const setRailHidden = useApp((s) => s.setRailHidden)
  // Floating, it covers the chat's edge, so it behaves like anything else laid
  // over the work: a click or focus anywhere else — the composer, the
  // transcript — puts it away, and so does Escape. The top bar's button is
  // exempt, or its own click would dismiss the rail it is about to toggle.
  React.useEffect(() => {
    if (!floating) return
    const outside = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      !ref.current?.contains(target) &&
      !(target instanceof Element && target.closest('[data-rail-toggle]'))
    const onPointer = (e: PointerEvent): void => {
      if (outside(e.target)) setRailHidden(true)
    }
    const onFocus = (e: FocusEvent): void => {
      if (outside(e.target)) setRailHidden(true)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setRailHidden(true)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('focusin', onFocus, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [floating, setRailHidden])
  return (
    <aside
      ref={ref}
      data-quick-rail
      data-floating={floating || undefined}
      aria-label="Session details"
      className={cn(
        'flex w-72 shrink-0 flex-col gap-3 overflow-y-auto p-3',
        // Box shadows on the cards, not a `drop-shadow` filter on the column: a
        // filter re-rasterizes the whole rail on every change inside it.
        floating && 'absolute top-0 right-0 z-20 max-h-full [&>section]:shadow-[var(--elevation-2)]'
      )}
    >
      <EnvironmentCard chat={chat} />
      <ContextCard chat={chat} />
      <ChangesCard />
      {!panelOpen && <PanelLaunchList title="Open in panel" />}
    </aside>
  )
}

/**
 * Whether the chat beside the rail would drop under a readable width. Measured
 * on the rail's parent (the thread's body), and only the crossing is stored, so
 * a window drag re-renders the rail twice at most rather than every frame.
 */
const NARROW_PX = 1040

function useNarrow(ref: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = React.useState(false)
  React.useEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_PX))
    observer.observe(parent)
    return () => observer.disconnect()
  }, [ref])
  return narrow
}

function Card({
  title,
  aside,
  children
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="surface-card p-2">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 pb-1.5">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        {aside && <span className="ml-auto flex items-center">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

function Row({
  icon: Icon,
  children,
  title
}: {
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <div title={title} className="flex min-w-0 items-center gap-2.5 px-2 py-1.5 text-[13px]">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {children}
    </div>
  )
}

function EnvironmentCard({ chat }: { chat: ChatMeta }): React.JSX.Element {
  const git = useApp((s) => s.git)
  const shown = git?.isRepo ? git.branch : undefined
  return (
    <Card title="Environment" aside={<span className="text-[11px] text-muted-foreground/70">{PROVIDER_SHORT_LABELS[chat.provider]}</span>}>
      <div className="surface-group flex flex-col py-0.5">
        <Row icon={Folder} title={chat.cwd}>
          <span className="truncate">{basename(chat.cwd)}</span>
        </Row>
        {shown && (
          <Row icon={GitBranch}>
            <span className="min-w-0 truncate">{shown}</span>
            {/* Against its own upstream: what a push or pull would move. */}
            {(git!.ahead > 0 || git!.behind > 0) && (
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                {git!.ahead > 0 && (
                  <span className="flex items-center">
                    <ArrowUp className="size-3" />
                    {git!.ahead}
                  </span>
                )}
                {git!.behind > 0 && (
                  <span className="flex items-center">
                    <ArrowDown className="size-3" />
                    {git!.behind}
                  </span>
                )}
              </span>
            )}
          </Row>
        )}
        <Row icon={chat.worktree ? Split : Laptop}>
          <span className="truncate">{chat.worktree ? 'Worktree' : 'This Mac'}</span>
        </Row>
      </div>
    </Card>
  )
}

function ContextCard({ chat }: { chat: ChatMeta }): React.JSX.Element | null {
  const used = chat.contextTokens
  if (!used) return null
  const win = chat.contextWindow ?? 200_000
  const pct = Math.min(1, used / win)
  return (
    <Card
      title="Context"
      aside={
        <span
          className={cn(
            'text-xs tabular-nums',
            pct > 0.9 ? 'text-destructive' : pct > 0.7 ? 'text-amber-500' : 'text-muted-foreground'
          )}
        >
          {Math.round(pct * 100)}%
        </span>
      }
    >
      <div className="px-1.5 pb-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              pct > 0.9 ? 'bg-destructive' : pct > 0.7 ? 'bg-amber-500' : 'bg-primary'
            )}
            style={{ width: `${Math.max(2, pct * 100)}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
          <span>{formatTokens(used)} used</span>
          <span>of {formatTokens(win)}</span>
        </div>
      </div>
    </Card>
  )
}

function ChangesCard(): React.JSX.Element | null {
  const git = useApp((s) => s.git)
  const reviewChanges = useApp((s) => s.reviewChanges)
  if (!git?.isRepo) return null
  const files = git.changes.length
  return (
    <Card title="Changes">
      <div className="surface-group flex flex-col py-0.5">
        {files === 0 ? (
          <div className="px-2 py-1.5 text-[13px] text-muted-foreground">No uncommitted changes</div>
        ) : (
          <button
            type="button"
            onClick={() => void reviewChanges()}
            className="flex min-w-0 items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
          >
            <FileDiff className="size-4 shrink-0 text-muted-foreground" />
            <span className="tabular-nums">
              <span className="text-success">+{git.additions}</span>{' '}
              <span className="text-destructive">−{git.deletions}</span>
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
              {files} {files === 1 ? 'file' : 'files'}
            </span>
          </button>
        )}
      </div>
      {/* Under the changes rather than in the title row, where the longer
          rungs ("Create Branch & Commit") ran out of the card. */}
      {files > 0 && (
        <div className="mt-2 flex justify-end">
          <GitActionButton />
        </div>
      )}
    </Card>
  )
}

