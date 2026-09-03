import * as React from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import { ChevronRight, ClipboardList, MessageCircleQuestion, ShieldAlert } from 'lucide-react'
import type { PermissionRequestPayload, Provider, UserQuestion } from '@shared/types'
import { PROVIDER_SHORT_LABELS } from '@shared/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useApp } from '@/store'

/**
 * Everything the agent asks you, docked on the composer.
 *
 * A pending request is **state, not an event** — the argument `TaskDock` and
 * `AgentActivityBar` already make, and the one the transcript cannot hold. It
 * has exactly one current value, it *blocks the turn*, and it must not be
 * scrollable away: drawn as the last thing in the transcript it was on screen
 * only for as long as you left the scroller pinned, so glancing up at the work
 * the agent was asking about took the question itself off screen with nothing
 * left to say the turn was waiting. There is now one place a question is ever
 * asked, it is glued to the input the answer would be typed into, and it is
 * always where you left it.
 *
 * The answered prompt leaves **no** record here, and deliberately: the tool row
 * is the record. A call that ran shows its result, a denied one keeps its own
 * glyph and destructive text (`ToolCard`), so a "you allowed npm test" card
 * would be the second telling of a thing already told.
 *
 * The three kinds share one frame, which is the other half of the fix. They
 * were three near-identical boxes — `border-warning/40 bg-warning/8`,
 * `border-primary/30 bg-primary/4`, `border-primary/30 bg-primary/5` — for one
 * moment ("the agent is waiting on you"), and two boxes that nearly agree read
 * worse than one that does. The tint is also held back to the header band
 * rather than flooding the whole card: this app carries state in a glyph and a
 * bar at the edge (`DiffView`) and narrates in muted rows (`ToolCard`), so a
 * fully tinted box was the loudest object on a screen designed around not
 * having one. Position does the work the flood was doing — it is attached to
 * the composer, where the eye and the hands already are.
 */
export function PromptDock({
  chatId,
  provider,
  requests,
  onReviewPlan
}: {
  /** The chat that asked — a side chat is never the active one. */
  chatId: string
  provider: Provider
  requests: PermissionRequestPayload[]
  onReviewPlan: (plan: string) => void
}): React.JSX.Element | null {
  // **One is open at a time, and the rest are one-line rows.** Drawn in full,
  // four parallel calls stacked four identical "Claude needs permission" bands
  // and twelve buttons into a box that then clipped the fourth mid-row, and the
  // composer took 56% of the window to say one thing four times. They are
  // answered one at a time whatever the box does, so the box says so: the open
  // prompt is the whole thing, the others are their own subject and a click.
  // That is `ToolGroup`'s grammar, and it is also what makes the keyboard
  // binding honest — Enter answers the prompt you can read, and there is
  // exactly one of those.
  //
  // Held by **id, not index**: answering removes a request from the array, and
  // an index would then point at whichever prompt shuffled into that slot. A
  // missing id falls back to the first, which is what promotes the next one.
  const [openId, setOpenId] = React.useState<string | null>(null)
  const open = requests.find((r) => r.id === openId) ?? requests[0]
  if (requests.length === 0) return null
  const count = requests.length > 1 ? requests.length : 0
  return (
    // Capped and scrolled for `TaskDock`'s reason at full strength: Claude fans
    // out several calls at once, and a stack of prompts would otherwise push
    // the input off the bottom of the window. Collapsing them is not on the
    // table — you cannot answer a question you cannot read.
    //
    // `first:rounded-t-2xl` rather than the unconditional rounding the other
    // two docks use: theirs are transparent, so a rounded corner in the middle
    // of the stack costs nothing, where a tinted band would show the card
    // through the corner as a notch. The scroll container clips it for free.
    // It assumes `Composer` renders `{header}` as its first child — anything
    // unconditional placed above it there takes the corner with it, and the
    // band goes square against the composer's own 2xl radius.
    <div
      data-prompt-dock
      className="max-h-[52vh] overflow-y-auto border-b border-border first:rounded-t-2xl"
    >
      {requests.map((request, i) => {
        const first = i === 0
        if (request.id !== open.id)
          return (
            <SummaryRow
              key={request.id}
              request={request}
              provider={provider}
              first={first}
              onOpen={() => setOpenId(request.id)}
            />
          )
        const at = count ? { index: i + 1, total: count } : undefined
        if (request.toolName === 'AskUserQuestion')
          return (
            <QuestionPrompt
              key={request.id}
              request={request}
              chatId={chatId}
              provider={provider}
              first={first}
              at={at}
            />
          )
        if (request.toolName === 'ExitPlanMode')
          return (
            <PlanPrompt
              key={request.id}
              request={request}
              provider={provider}
              first={first}
              at={at}
              onReviewPlan={onReviewPlan}
            />
          )
        return (
          // The open prompt owns Enter and Esc, which is the whole reason only
          // one is open: with four cards mounted, four window listeners fired
          // on one keypress and the reader had no way to tell which card the
          // key had gone to.
          <PermissionPrompt
            key={request.id}
            request={request}
            chatId={chatId}
            provider={provider}
            first={first}
            at={at}
            keyboard
          />
        )
      })}
    </div>
  )
}

type Tone = 'permission' | 'ask'

/**
 * The one frame all three wear: a tinted band naming who is waiting and what
 * for, then the body, then the answer.
 */
function PromptFrame({
  tone,
  icon,
  title,
  hint,
  at,
  first,
  children
}: {
  tone: Tone
  icon: React.ReactNode
  title: string
  hint?: React.ReactNode
  /** Where this one sits in a stack of several. Absent when it is the only one. */
  at?: { index: number; total: number }
  first: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('animate-enter', !first && 'border-t border-border')}>
      <div
        className={cn(
          'flex items-center gap-2 px-3.5 py-2',
          tone === 'permission'
            ? 'bg-warning/10 dark:bg-warning/8'
            : 'bg-primary/10 dark:bg-primary/12'
        )}
      >
        <span
          className={cn(
            'shrink-0 [&_svg]:size-3.5',
            tone === 'permission' ? 'text-warning' : 'text-primary'
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        {at && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {at.index} of {at.total}
          </span>
        )}
        {hint}
      </div>
      {children}
    </div>
  )
}

/**
 * The body of an open prompt: the one part allowed to scroll.
 *
 * The cap is here rather than on the dock, and that is the fix for the second
 * crowded shape. `AskUserQuestion` may carry four blocks of options; capped at
 * the dock, the whole prompt scrolled and **Submit went below the fold with
 * nothing on screen to say it existed** — a question that cannot be submitted
 * looks exactly like one that is broken. Scrolling the body alone keeps the
 * answer row where the answer is given.
 */
function PromptBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="max-h-[28vh] overflow-y-auto px-3.5 pt-2.5">{children}</div>
}

/**
 * A prompt waiting behind the open one: its own subject, and a click.
 *
 * It shows the **subject** rather than the band's "Claude needs permission",
 * which is what four stacked bands proved: repeated, that line distinguishes
 * nothing, and a queue whose rows are identical is a queue you cannot choose
 * from. A question's row is the question itself for the same reason.
 */
function SummaryRow({
  request,
  provider,
  first,
  onOpen
}: {
  request: PermissionRequestPayload
  provider: Provider
  first: boolean
  onOpen: () => void
}): React.JSX.Element {
  const kind = kindOf(request)
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full items-center gap-2 px-3.5 py-1.5 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40',
        !first && 'border-t border-border'
      )}
    >
      <span
        className={cn(
          'shrink-0 [&_svg]:size-3',
          kind === 'permission' ? 'text-warning/70' : 'text-primary/70'
        )}
      >
        {iconOf(kind)}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {subjectOf(request, provider)}
      </span>
    </button>
  )
}

type Kind = 'permission' | 'question' | 'plan'

function kindOf(request: PermissionRequestPayload): Kind {
  if (request.toolName === 'AskUserQuestion') return 'question'
  if (request.toolName === 'ExitPlanMode') return 'plan'
  return 'permission'
}

function iconOf(kind: Kind): React.JSX.Element {
  if (kind === 'question') return <MessageCircleQuestion />
  if (kind === 'plan') return <ClipboardList />
  return <ShieldAlert />
}

/** What this prompt is *about*, in one line. */
function subjectOf(request: PermissionRequestPayload, provider: Provider): string {
  const kind = kindOf(request)
  if (kind === 'plan') return `${PROVIDER_SHORT_LABELS[provider]} prepared a plan`
  if (kind === 'question') {
    const questions = (request.input as { questions?: UserQuestion[] } | null)?.questions
    const first = Array.isArray(questions) ? questions[0]?.question : undefined
    return first || `${PROVIDER_SHORT_LABELS[provider]} has a question`
  }
  return request.title ?? `Use ${request.displayName ?? request.toolName}`
}

/** The row the answer sits on, so the three kinds cannot drift apart. */
function PromptActions({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex items-center justify-end gap-2 px-3.5 py-2.5">{children}</div>
}

function summarize(request: PermissionRequestPayload): string | null {
  const input = (request.input ?? {}) as Record<string, unknown>
  const candidate = input.command ?? input.file_path ?? input.url ?? input.pattern ?? null
  return typeof candidate === 'string' ? candidate : null
}

/**
 * Whether a keypress with this element focused may answer a permission prompt.
 *
 * The answer is "when the key would otherwise do nothing": nothing focused, or
 * the composer with nothing typed in it. A non-empty composer is a message being
 * written, where Enter sends and Esc is the user's own; any other input is a
 * dialog or a rename, and a menu item focuses itself while its menu is open, so
 * every one of those falls through to the buttons. `value` is read off the
 * element rather than the store because the composer keeps its text out of
 * zustand on purpose (see Drafts) — the DOM is the only place it is current.
 *
 * It matches the message box **by name** and not by
 * `closest('[data-composer]')`, which is what it used to do and what stopped
 * being true here: the review picker is inside that box now, so its
 * custom-instructions textarea satisfied the old test, and an empty one — the
 * state it is in while you are deciding what to type — read as an empty message
 * and let Enter allow the prompt sitting under it.
 */
function keyMayAnswer(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null
  if (!el || el === document.body) return true
  if (el instanceof HTMLTextAreaElement && el.matches('[data-composer-input]')) {
    return el.value.trim() === ''
  }
  return false
}

/**
 * Which chat's transcript a keypress happened *in*, or null for one that
 * happened nowhere in particular (nothing focused — by far the common case).
 *
 * There are two transcripts on screen once a side chat is open, each with its
 * own oldest pending prompt, so `keyboard` alone stops meaning "this card owns
 * the keys": both cards would set it and both window listeners would fire on
 * one Enter, answering two prompts the user only meant to answer one of. And
 * `keyMayAnswer` cannot break the tie on its own — it unlocks on *either*
 * composer being empty, so typing in the main column while the side composer
 * sits empty still lets the key through.
 *
 * `data-chat-surface` rather than `data-chatview`: the latter is the frosted
 * main column, which a side chat inside the right panel is not. The dock lives
 * inside that element too, so a click into the prompt itself resolves here.
 */
function focusedChat(target: EventTarget | null): string | null {
  const el = target instanceof HTMLElement ? target : null
  const view = el?.closest('[data-chat-surface]')
  return view instanceof HTMLElement ? view.dataset.chatSurface || null : null
}

function PermissionPrompt({
  request,
  chatId,
  provider,
  first,
  at,
  keyboard
}: {
  request: PermissionRequestPayload
  chatId: string
  provider: Provider
  first: boolean
  at?: { index: number; total: number }
  /**
   * This is the prompt Enter and Esc answer. Only the *open* prompt is ever
   * mounted with a body, so there is exactly one of these per transcript;
   * which transcript answers is decided at the keypress by `focusedChat`.
   */
  keyboard: boolean
}): React.JSX.Element {
  const respondPermission = useApp((s) => s.respondPermission)
  const activeId = useApp((s) => s.activeId)
  const [busy, setBusy] = React.useState(false)
  const summary = summarize(request)
  const authorizationUrl =
    request.toolName === 'McpElicitation' &&
    typeof (request.input as Record<string, unknown> | null)?.url === 'string'
      ? ((request.input as Record<string, unknown>).url as string)
      : null

  const respond = async (decision: Parameters<typeof respondPermission>[2]): Promise<void> => {
    setBusy(true)
    if (decision.behavior === 'allow' && authorizationUrl) {
      try {
        await window.api.openExternal(authorizationUrl)
      } catch {
        // The protocol response must still be resolved if the OS rejects the URL.
      }
    }
    await respondPermission(chatId, request.id, decision)
  }

  // Enter allows, Esc denies. "Feels fast" in an agent GUI is mostly how
  // quickly you can say yes, and a prompt that needs the mouse while your hands
  // are on the keyboard is the slowest thing on screen. The listener rides the
  // window in the bubble phase, so anything that handles the key itself has
  // already run; `keyMayAnswer` is what keeps it out of a message being typed
  // and out of every dialog. The `busy` check is the double-fire guard — the
  // card stays mounted until the response round-trips.
  const respondRef = React.useRef(respond)
  respondRef.current = respond
  React.useEffect(() => {
    if (!keyboard) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return
      if (e.key !== 'Enter' && e.key !== 'Escape') return
      // The review picker sits in this same dock and closes on Escape from a
      // capture listener that marks the event handled. Without this check one
      // Escape would both close the picker and deny the prompt under it.
      if (e.defaultPrevented) return
      if (!keyMayAnswer(e.target)) return
      // The transcript holding focus answers; with focus nowhere, the main
      // column does. A side chat is never the active chat, so this is also what
      // stops a background side chat's prompt from swallowing the key.
      const focused = focusedChat(e.target)
      if (focused ? focused !== chatId : chatId !== activeId) return
      e.preventDefault()
      void respondRef.current({ behavior: e.key === 'Enter' ? 'allow' : 'deny' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // `busy` is a dep so a card that has answered stops listening at once,
    // rather than on unmount.
  }, [keyboard, busy, chatId, activeId])

  return (
    <PromptFrame
      tone="permission"
      first={first}
      at={at}
      icon={<ShieldAlert />}
      title={`${PROVIDER_SHORT_LABELS[provider]} needs permission`}
      hint={
        keyboard && !busy ? (
          <span className="shrink-0 text-[11px] text-muted-foreground/70 select-none">
            <kbd className="font-sans">↵</kbd> allow · <kbd className="font-sans">esc</kbd> deny
          </span>
        ) : undefined
      }
    >
      <PromptBody>
        {/* The provider is named in the band, so the fallback no longer says
            "Claude" on a chat that is not Claude's — Grok reaches it whenever
            the closing ACP payload carries no title. */}
        <div className="text-[13px] font-medium">{subjectOf(request, provider)}</div>
        {request.description && (
          <div className="mt-0.5 text-xs text-muted-foreground">{request.description}</div>
        )}
        {request.decisionReason && (
          <div className="mt-0.5 text-[11px] text-muted-foreground/70">{request.decisionReason}</div>
        )}
        {summary && (
          <div className="mt-1.5 max-h-24 overflow-y-auto rounded-md border border-border bg-code px-2 py-1 font-mono text-xs break-all select-text text-muted-foreground">
            {summary}
          </div>
        )}
        <Collapsible.Root>
          <Collapsible.Trigger className="group mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground outline-none hover:text-foreground">
            <ChevronRight className="size-3 transition-transform duration-200 group-data-[panel-open]:rotate-90" />
            Details
          </Collapsible.Trigger>
          <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 data-[ending-style]:h-0 data-[starting-style]:h-0">
            <pre className="mt-1.5 max-h-48 overflow-auto rounded-md border border-border bg-code p-2 font-mono text-[11px] whitespace-pre-wrap select-text">
              {JSON.stringify(request.input, null, 2)}
            </pre>
          </Collapsible.Panel>
        </Collapsible.Root>
      </PromptBody>
      <PromptActions>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void respond({ behavior: 'deny' })}
        >
          Deny
        </Button>
        {request.hasSuggestions && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void respond({ behavior: 'allow', always: true })}
          >
            Always allow
          </Button>
        )}
        <Button size="sm" disabled={busy} onClick={() => void respond({ behavior: 'allow' })}>
          {authorizationUrl ? 'Open & continue' : 'Allow'}
        </Button>
      </PromptActions>
    </PromptFrame>
  )
}

function PlanPrompt({
  request,
  provider,
  first,
  at,
  onReviewPlan
}: {
  request: PermissionRequestPayload
  provider: Provider
  first: boolean
  at?: { index: number; total: number }
  onReviewPlan: (plan: string) => void
}): React.JSX.Element {
  const plan = (request.input as { plan?: string } | null)?.plan
  return (
    <PromptFrame
      tone="ask"
      first={first}
      at={at}
      icon={<ClipboardList />}
      title={`${PROVIDER_SHORT_LABELS[provider]} prepared a plan for your review`}
      hint={
        <Button
          size="sm"
          variant="secondary"
          className="-my-1 h-6 shrink-0"
          disabled={typeof plan !== 'string'}
          onClick={() => {
            if (typeof plan === 'string') onReviewPlan(plan)
          }}
        >
          Review plan
        </Button>
      }
    >
      {/* Nothing else: the plan has a panel of its own, and repeating its first
          lines here would be a preview of the thing one click away. */}
      <></>
    </PromptFrame>
  )
}

const OTHER = '__other__'

function QuestionBlock({
  question,
  selected,
  otherText,
  onToggle,
  onOtherText
}: {
  question: UserQuestion
  selected: Set<string>
  otherText: string
  onToggle: (label: string) => void
  onOtherText: (text: string) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-primary uppercase">
          {question.header}
        </span>
        {question.multiSelect && (
          <span className="text-[10px] text-muted-foreground">select all that apply</span>
        )}
      </div>
      <div className="mb-2 text-[13.5px] font-medium">{question.question}</div>
      <div className="flex flex-col gap-1.5">
        {question.options.map((option) => {
          const active = selected.has(option.label)
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => onToggle(option.label)}
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition-colors',
                active
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-border hover:border-ring/40 hover:bg-accent/50'
              )}
            >
              <div className="text-[13px] font-medium">{option.label}</div>
              {option.description && (
                <div className="mt-0.5 text-xs text-muted-foreground">{option.description}</div>
              )}
            </button>
          )
        })}
        {question.allowOther !== false && (
          <button
            type="button"
            onClick={() => onToggle(OTHER)}
            className={cn(
              'rounded-lg border px-3 py-2 text-left transition-colors',
              selected.has(OTHER)
                ? 'border-primary/60 bg-primary/10'
                : 'border-border hover:border-ring/40 hover:bg-accent/50'
            )}
          >
            <div className="text-[13px] font-medium">Other</div>
            {selected.has(OTHER) && (
              <Input
                type={question.isSecret ? 'password' : 'text'}
                value={otherText}
                onChange={(e) => onOtherText(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                autoFocus
                placeholder="Type your answer…"
                className="mt-1.5 h-7 bg-background/60"
              />
            )}
          </button>
        )}
      </div>
    </div>
  )
}

function QuestionPrompt({
  request,
  chatId,
  provider,
  first,
  at
}: {
  request: PermissionRequestPayload
  chatId: string
  provider: Provider
  first: boolean
  at?: { index: number; total: number }
}): React.JSX.Element {
  const respondPermission = useApp((s) => s.respondPermission)
  const [busy, setBusy] = React.useState(false)

  const questions = React.useMemo<UserQuestion[]>(() => {
    const input = request.input as { questions?: UserQuestion[] } | null
    return Array.isArray(input?.questions) ? input.questions : []
  }, [request.input])

  // Keyed by question *index*, not text — two questions can share the same
  // `question` string, which would otherwise collide their selection state.
  const [selected, setSelected] = React.useState<Record<number, Set<string>>>({})
  const [otherText, setOtherText] = React.useState<Record<number, string>>({})

  const toggle = (i: number, q: UserQuestion, label: string): void => {
    setSelected((prev) => {
      const current = new Set(prev[i] ?? [])
      if (q.multiSelect) {
        if (current.has(label)) current.delete(label)
        else current.add(label)
      } else {
        current.clear()
        current.add(label)
      }
      return { ...prev, [i]: current }
    })
  }

  const answerValues = (i: number): string[] | null => {
    const picks = selected[i]
    if (!picks || picks.size === 0) return null
    const labels = [...picks].map((l) => (l === OTHER ? (otherText[i] ?? '').trim() : l))
    if (labels.some((l) => !l)) return null
    return labels
  }

  const answered = questions.filter((_, i) => answerValues(i) !== null).length
  const complete =
    questions.length > 0 &&
    questions.every((question, i) => question.required === false || answerValues(i) !== null)

  const submit = (): void => {
    const answers: Record<string, string> = {}
    const answersById: Record<string, string[]> = {}
    questions.forEach((q, i) => {
      const values = answerValues(i)
      if (!values) return
      answers[q.question] = values.join(', ')
      if (q.id) answersById[q.id] = values
    })
    setBusy(true)
    void respondPermission(chatId, request.id, {
      behavior: 'allow',
      updatedInput:
        provider === 'codex'
          ? { ...(request.input as Record<string, unknown>), answers, answersById }
          : { ...(request.input as Record<string, unknown>), answers }
    })
  }

  return (
    <PromptFrame
      tone="ask"
      first={first}
      at={at}
      icon={<MessageCircleQuestion />}
      title={`${PROVIDER_SHORT_LABELS[provider]} has a question`}
      hint={
        // Only for a multi-block ask, and it is what makes a disabled Submit
        // legible: the body scrolls, so "why can I not submit" is otherwise a
        // question about options that may be off screen.
        questions.length > 1 ? (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {answered} of {questions.length} answered
          </span>
        ) : undefined
      }
    >
      <PromptBody>
        <div className="space-y-4 pb-0.5">
        {questions.map((q, i) => (
          <QuestionBlock
            key={i}
            question={q}
            selected={selected[i] ?? new Set()}
            otherText={otherText[i] ?? ''}
            onToggle={(label) => toggle(i, q, label)}
            onOtherText={(text) => setOtherText((prev) => ({ ...prev, [i]: text }))}
          />
        ))}
        </div>
      </PromptBody>
      <PromptActions>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void respondPermission(chatId, request.id, {
              behavior: 'deny',
              message: 'The user dismissed the questions.'
            })
          }}
        >
          Dismiss
        </Button>
        <Button size="sm" disabled={!complete || busy} onClick={submit}>
          Submit
        </Button>
      </PromptActions>
    </PromptFrame>
  )
}
