import * as React from 'react'
import type { PermissionDecision, PermissionRequestPayload, Provider } from '@shared/types'
import { PROVIDER_SHORT_LABELS } from '@shared/types'
import { useRemote } from './state'
import { RemoteMarkdown } from './Markdown'
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
  return (
    <div className="prompt">
      <div className="prompt-title">
        {agent} wants to use {request.displayName ?? label}
      </div>
      {request.description && <div className="prompt-desc">{request.description}</div>}
      {detail && <pre className="prompt-detail">{detail}</pre>}
      {request.decisionReason && <div className="prompt-desc muted">{request.decisionReason}</div>}
      <div className="prompt-actions">
        <button type="button" className="btn ghost" disabled={busy} onClick={() => answer({ behavior: 'deny' })}>
          Deny
        </button>
        {always && (
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => answer({ behavior: 'allow', always: true })}
          >
            Always
          </button>
        )}
        <button type="button" className="btn primary" disabled={busy} onClick={() => answer({ behavior: 'allow' })}>
          Allow
        </button>
      </div>
    </div>
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
    <div className="prompt plan">
      <div className="prompt-title">{agent} has a plan ready</div>
      {plan && (
        <div className={`plan-body ${expanded ? 'open' : ''}`} onClick={() => setExpanded(true)}>
          <RemoteMarkdown text={plan} />
        </div>
      )}
      <textarea
        className="feedback"
        rows={1}
        placeholder="Ask for changes…"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      <div className="prompt-actions">
        <button
          type="button"
          className="btn ghost"
          disabled={busy || !feedback.trim()}
          onClick={() => answer({ behavior: 'deny', message: feedback.trim() })}
        >
          Request changes
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => answer({ behavior: 'allow' })}>
          Approve
        </button>
      </div>
    </div>
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
    <div className="prompt question">
      <div className="prompt-title">{agent} has a question</div>
      <div className="questions">
        {questions.map((q, i) => (
          <div key={i} className="q">
            <div className="q-text">{q.question}</div>
            <div className="q-options">
              {(q.options ?? []).map((o) => (
                <button
                  type="button"
                  key={o.label}
                  className={`q-option ${picked[i]?.includes(o.label) && !other[i]?.trim() ? 'on' : ''}`}
                  onClick={() => toggle(i, q, o.label)}
                >
                  <span>{o.label}</span>
                  {o.description && <small>{o.description}</small>}
                </button>
              ))}
            </div>
            <input
              className="q-other"
              placeholder="Or type an answer"
              value={other[i] ?? ''}
              onChange={(e) => setOther((prev) => ({ ...prev, [i]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="prompt-actions">
        <button
          type="button"
          className="btn ghost"
          disabled={busy}
          onClick={() => answer({ behavior: 'deny', message: 'The user dismissed the questions.' })}
        >
          Dismiss
        </button>
        <button type="button" className="btn primary" disabled={busy || !complete} onClick={submit}>
          Submit
        </button>
      </div>
    </div>
  )
}
