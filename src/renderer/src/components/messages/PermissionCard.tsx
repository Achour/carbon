import * as React from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import { ChevronRight, ShieldAlert } from 'lucide-react'
import type { PermissionRequestPayload } from '@shared/types'
import { Button } from '@/components/ui/button'
import { useApp } from '@/store'

function summarize(request: PermissionRequestPayload): string | null {
  const input = (request.input ?? {}) as Record<string, unknown>
  const candidate = input.command ?? input.file_path ?? input.url ?? input.pattern ?? null
  return typeof candidate === 'string' ? candidate : null
}

export function PermissionCard({
  request
}: {
  request: PermissionRequestPayload
}): React.JSX.Element {
  const respondPermission = useApp((s) => s.respondPermission)
  const [busy, setBusy] = React.useState(false)
  const summary = summarize(request)

  const respond = (decision: Parameters<typeof respondPermission>[1]): void => {
    setBusy(true)
    void respondPermission(request.id, decision)
  }

  return (
    <div className="animate-enter overflow-hidden rounded-xl border border-warning/40 bg-warning/8 dark:bg-warning/6">
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">
            {request.title ?? `Claude wants to use ${request.displayName ?? request.toolName}`}
          </div>
          {request.description && (
            <div className="mt-0.5 text-xs text-muted-foreground">{request.description}</div>
          )}
          {request.decisionReason && (
            <div className="mt-0.5 text-[11px] text-muted-foreground/70">
              {request.decisionReason}
            </div>
          )}
          {summary && (
            <div className="mt-1.5 select-text rounded-md border border-border bg-code px-2 py-1 font-mono text-xs break-all text-muted-foreground">
              {summary}
            </div>
          )}
          <Collapsible.Root>
            <Collapsible.Trigger className="group mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground outline-none hover:text-foreground">
              <ChevronRight className="size-3 transition-transform duration-200 group-data-[panel-open]:rotate-90" />
              Details
            </Collapsible.Trigger>
            <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 data-[ending-style]:h-0 data-[starting-style]:h-0">
              <pre className="mt-1.5 max-h-48 select-text overflow-auto rounded-md border border-border bg-code p-2 font-mono text-[11px] whitespace-pre-wrap">
                {JSON.stringify(request.input, null, 2)}
              </pre>
            </Collapsible.Panel>
          </Collapsible.Root>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 px-3.5 py-2.5">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => respond({ behavior: 'deny' })}>
          Deny
        </Button>
        {request.hasSuggestions && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => respond({ behavior: 'allow', always: true })}
          >
            Always allow
          </Button>
        )}
        <Button size="sm" disabled={busy} onClick={() => respond({ behavior: 'allow' })}>
          Allow
        </Button>
      </div>
    </div>
  )
}
