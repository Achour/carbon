import * as React from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import type { PermissionRequestPayload, Provider, UserQuestion } from '@shared/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useApp } from '@/store'

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

export function QuestionCard({
  request,
  provider
}: {
  request: PermissionRequestPayload
  provider: Provider
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
    void respondPermission(request.id, {
      behavior: 'allow',
      updatedInput:
        provider === 'codex'
          ? { ...(request.input as Record<string, unknown>), answers, answersById }
          : { ...(request.input as Record<string, unknown>), answers }
    })
  }

  return (
    <div className="animate-enter rounded-xl border border-primary/30 bg-primary/4 dark:bg-primary/6">
      <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-2.5">
        <MessageCircleQuestion className="size-4 text-primary" />
        <span className="text-[13px] font-semibold">
          {provider === 'codex' ? 'Codex' : 'Claude'} has a question
        </span>
      </div>
      <div className="space-y-4 px-3.5 py-3">
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
      <div className="flex items-center justify-end gap-2 px-3.5 pb-3">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void respondPermission(request.id, { behavior: 'deny', message: 'The user dismissed the questions.' })
          }}
        >
          Dismiss
        </Button>
        <Button size="sm" disabled={!complete || busy} onClick={submit}>
          Submit
        </Button>
      </div>
    </div>
  )
}
