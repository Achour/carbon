import * as React from 'react'
import { ChevronDown, ClipboardList, MessageCircleQuestion, ShieldQuestion } from 'lucide-react'
import type { PermissionDecision, PermissionRequestPayload, Provider } from '@shared/types'
import { PROVIDER_SHORT_LABELS } from '@shared/types'
import { cn } from '@/lib/utils'
import { useRemote } from './state'
import { Markdown } from '@/components/Markdown'
import { toolLine } from './format'

interface UserQuestion {
  question: string
  header?: string
  id?: string
  multiSelect?: boolean
  options?: { label: string; description?: string }[]
}

/**
 * What the agent is waiting on, docked above the composer. Three shapes, as on
 * the desktop: a plan to approve, questions to answer, and a tool to allow.
 * The decisions sent are the desktop's own (`PlanPanel`, `PromptDock`), so a
 * provider cannot tell which screen answered.
 */
export function PermissionCard({
  chatId,
  request,
  provider
}: {
  chatId: string
  request: PermissionRequestPayload
  provider: Provider
}): React.JSX.Element {
  const respond = useRemote((s) => s.respond)
  const [busy, setBusy] = React.useState(false)
  const answer = (decision: PermissionDecision): void => {
    setBusy(true)
    void respond(chatId, request.id, decision)
  }
  const agent = PROVIDER_SHORT_LABELS[provider]

  if (request.toolName === 'ExitPlanMode') return <PlanCard request={request} agent={agent} busy={busy} answer={answer} />
  if (request.toolName === 'AskUserQuestion')
    return <QuestionCard request={request} agent={agent} provider={provider} busy={busy} answer={answer} />

  const { label, detail } = toolLine({ name: request.toolName, input: request.input })
  const always = request.hasSuggestions && !request.noAlwaysAllow
  const preview = previewOf(request.input)
  return (
    <Card icon={<ShieldQuestion className="size-4 text-warning" />} title={`${agent} wants to use ${request.displayName ?? label}`}>
      {(request.description || detail) && (
        <p className="truncate font-mono text-[13px] text-muted-foreground">{request.description ?? detail}</p>
      )}
      {preview && (
        <div className="max-h-48 overflow-auto rounded-xl bg-code px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-all select-text">
          {preview.map((l, i) => (
            <div
              key={i}
              className={cn(l.kind === 'del' && 'text-destructive', l.kind === 'add' && 'text-success')}
            >
              {l.kind === 'del' ? '− ' : l.kind === 'add' ? '+ ' : ''}
              {l.text}
            </div>
          ))}
        </div>
      )}
      {request.decisionReason && <p className="text-[13px] text-muted-foreground">{request.decisionReason}</p>}
      <Actions>
        <Btn kind="ghost" disabled={busy} onClick={() => answer({ behavior: 'deny' })}>
          Deny
        </Btn>
        {always && (
          <Btn kind="secondary" disabled={busy} onClick={() => answer({ behavior: 'allow', always: true })}>
            Always allow
          </Btn>
        )}
        <Btn kind="primary" disabled={busy} onClick={() => answer({ behavior: 'allow' })}>
          Allow
        </Btn>
      </Actions>
    </Card>
  )
}

type PreviewLine = { kind: 'add' | 'del' | 'plain'; text: string }

/** Lines past this are cut: the card is for deciding, not for reading the file. */
const PREVIEW_LINES = 40

/**
 * What the tool will actually do, which is what an approval is about: the
 * whole command, the text a write puts in the file, the lines an edit swaps.
 */
function previewOf(input: unknown): PreviewLine[] | null {
  const i = (input ?? {}) as Record<string, unknown>
  const lines = (v: unknown, kind: PreviewLine['kind']): PreviewLine[] =>
    typeof v === 'string' ? v.split('\n').map((text) => ({ kind, text })) : []
  let out: PreviewLine[] = []
  if (typeof i.command === 'string') out = lines(i.command, 'plain')
  else if (typeof i.content === 'string') out = lines(i.content, 'add')
  else if (typeof i.old_string === 'string' || typeof i.new_string === 'string')
    out = [...lines(i.old_string, 'del'), ...lines(i.new_string, 'add')]
  else if (Array.isArray(i.edits))
    out = (i.edits as Record<string, unknown>[]).flatMap((e) => [
      ...lines(e.old_string, 'del'),
      ...lines(e.new_string, 'add')
    ])
  if (!out.length) return null
  return out.length > PREVIEW_LINES
    ? [...out.slice(0, PREVIEW_LINES), { kind: 'plain', text: `… ${out.length - PREVIEW_LINES} more lines` }]
    : out
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex animate-in flex-col gap-2.5 rounded-[20px] border border-border bg-card p-4 shadow-[0_4px_20px_rgb(0_0_0/0.08)] fade-in slide-in-from-bottom-2">
      <div className="flex items-center gap-2 text-[15px] font-medium">
        {icon}
        <span className="min-w-0">{title}</span>
      </div>
      {children}
    </div>
  )
}

function Actions({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mt-1 flex justify-end gap-2">{children}</div>
}

function Btn({
  kind,
  disabled,
  onClick,
  children
}: {
  kind: 'primary' | 'secondary' | 'ghost'
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'h-10 rounded-full px-4 text-[14.5px] font-medium transition-[opacity,transform] duration-150 active:scale-[0.96] disabled:opacity-40',
        kind === 'primary' && 'bg-foreground text-background active:opacity-85',
        kind === 'secondary' && 'bg-secondary text-secondary-foreground active:opacity-80',
        kind === 'ghost' && 'text-muted-foreground active:bg-accent'
      )}
    >
      {children}
    </button>
  )
}

function PlanCard({
  request,
  agent,
  busy,
  answer
}: {
  request: PermissionRequestPayload
  agent: string
  busy: boolean
  answer: (d: PermissionDecision) => void
}): React.JSX.Element {
  const plan = (request.input as { plan?: string } | null)?.plan ?? ''
  const [feedback, setFeedback] = React.useState('')
  const [expanded, setExpanded] = React.useState(false)
  return (
    <Card icon={<ClipboardList className="size-4 text-sky-600 dark:text-sky-400" />} title={`${agent} has a plan ready`}>
      {plan && (
        <div className="relative">
          <div className={cn('overflow-hidden', !expanded && 'max-h-56')}>
            <Markdown text={plan} />
          </div>
          {!expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="absolute inset-x-0 bottom-0 flex h-16 items-end justify-center bg-gradient-to-t from-card to-transparent pb-1 text-[13px] font-medium text-muted-foreground"
            >
              <span className="flex items-center gap-1">
                Read the whole plan <ChevronDown className="size-3.5" />
              </span>
            </button>
          )}
        </div>
      )}
      <textarea
        rows={1}
        placeholder="Ask for changes…"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        className="min-h-10 w-full resize-none rounded-xl bg-muted px-3 py-2 text-[16px] outline-none placeholder:text-muted-foreground"
      />
      <Actions>
        {feedback.trim() ? (
          <Btn kind="secondary" disabled={busy} onClick={() => answer({ behavior: 'deny', message: feedback.trim() })}>
            Request changes
          </Btn>
        ) : null}
        <Btn kind="primary" disabled={busy} onClick={() => answer({ behavior: 'allow' })}>
          Approve plan
        </Btn>
      </Actions>
    </Card>
  )
}

function QuestionCard({
  request,
  agent,
  provider,
  busy,
  answer
}: {
  request: PermissionRequestPayload
  agent: string
  provider: Provider
  busy: boolean
  answer: (d: PermissionDecision) => void
}): React.JSX.Element {
  const input = (request.input ?? {}) as Record<string, unknown>
  const questions = (Array.isArray(input.questions) ? input.questions : []) as UserQuestion[]
  const [picked, setPicked] = React.useState<Record<number, string[]>>({})
  const [other, setOther] = React.useState<Record<number, string>>({})

  const values = (i: number): string[] => {
    const typed = other[i]?.trim()
    return typed ? [typed] : (picked[i] ?? [])
  }
  const complete = questions.every((_, i) => values(i).length > 0)

  const toggle = (i: number, q: UserQuestion, label: string): void =>
    setPicked((prev) => {
      const cur = prev[i] ?? []
      const next = q.multiSelect
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label]
      return { ...prev, [i]: next }
    })

  const submit = (): void => {
    const answers: Record<string, string> = {}
    const answersById: Record<string, string[]> = {}
    questions.forEach((q, i) => {
      const v = values(i)
      if (!v.length) return
      answers[q.question] = v.join(', ')
      if (q.id) answersById[q.id] = v
    })
    answer({
      behavior: 'allow',
      updatedInput: provider === 'codex' ? { ...input, answers, answersById } : { ...input, answers }
    })
  }

  return (
    <Card
      icon={<MessageCircleQuestion className="size-4 text-violet-600 dark:text-violet-400" />}
      title={questions.length === 1 ? `${agent} has a question` : `${agent} has ${questions.length} questions`}
    >
      {questions.map((q, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className="text-[15px] leading-snug">{q.question}</div>
          {q.multiSelect && <div className="text-[12.5px] text-muted-foreground">Pick any that apply</div>}
          <div className="flex flex-col gap-1">
            {(q.options ?? []).map((o) => {
              const on = !!picked[i]?.includes(o.label) && !other[i]?.trim()
              return (
                <button
                  type="button"
                  key={o.label}
                  onClick={() => toggle(i, q, o.label)}
                  className={cn(
                    'rounded-xl border px-3 py-2 text-left transition-[background-color,border-color,transform] duration-150 active:scale-[0.98]',
                    on ? 'border-foreground/60 bg-accent' : 'border-border active:bg-accent/60'
                  )}
                >
                  <span className="block text-[14.5px]">{o.label}</span>
                  {o.description && <span className="block text-[12.5px] leading-snug text-muted-foreground">{o.description}</span>}
                </button>
              )
            })}
          </div>
          <input
            placeholder="Or type an answer"
            value={other[i] ?? ''}
            onChange={(e) => setOther((prev) => ({ ...prev, [i]: e.target.value }))}
            className="h-10 rounded-xl bg-muted px-3 text-[16px] outline-none placeholder:text-muted-foreground"
          />
        </div>
      ))}
      <Actions>
        <Btn kind="ghost" disabled={busy} onClick={() => answer({ behavior: 'deny', message: 'The user dismissed the questions.' })}>
          Dismiss
        </Btn>
        <Btn kind="primary" disabled={busy || !complete} onClick={submit}>
          Submit
        </Btn>
      </Actions>
    </Card>
  )
}
