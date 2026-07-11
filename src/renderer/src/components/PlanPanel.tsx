import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/Markdown'
import { useApp, type PlanPanelState } from '@/store'

/** Plan tab content for the right panel: the plan markdown plus review actions. */
export function PlanContent({
  panel,
  hasSuggestions
}: {
  panel: PlanPanelState
  hasSuggestions: boolean
}): React.JSX.Element {
  const respondPermission = useApp((s) => s.respondPermission)
  const [feedback, setFeedback] = React.useState('')
  const [autoAccept, setAutoAccept] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const pending = panel.requestId !== null

  const approve = (): void => {
    if (!panel.requestId) return
    setBusy(true)
    void respondPermission(panel.requestId, {
      behavior: 'allow',
      always: autoAccept && hasSuggestions
    })
  }

  const requestChanges = (): void => {
    if (!panel.requestId || !feedback.trim()) return
    setBusy(true)
    void respondPermission(panel.requestId, { behavior: 'deny', message: feedback.trim() })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {pending && (
        <div className="shrink-0 border-b border-warning/30 bg-warning/8 px-4 py-1.5 text-[11px] font-medium text-warning">
          Awaiting your review
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <Markdown text={panel.plan} />
      </div>

      {pending && (
        <footer className="shrink-0 space-y-2.5 border-t border-border px-4 py-3">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            placeholder="Optional feedback — what should change?"
            className="no-drag block w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-[13px] outline-none select-text placeholder:text-muted-foreground/60 focus-visible:border-ring"
          />
          <div className="flex items-center gap-2">
            {hasSuggestions && (
              <button
                type="button"
                onClick={() => setAutoAccept((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <span
                  className={cn(
                    'flex size-3.5 items-center justify-center rounded border transition-colors',
                    autoAccept ? 'border-primary bg-primary' : 'border-input'
                  )}
                >
                  {autoAccept && (
                    <Check className="size-2.5 text-primary-foreground" strokeWidth={3} />
                  )}
                </span>
                Auto-accept edits
              </button>
            )}
            <div className="flex-1" />
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !feedback.trim()}
              onClick={requestChanges}
            >
              Request changes
            </Button>
            <Button size="sm" disabled={busy} onClick={approve}>
              Approve plan
            </Button>
          </div>
        </footer>
      )}
    </div>
  )
}
