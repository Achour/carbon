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
 */
function keyMayAnswer(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null
  if (!el || el === document.body) return true
  if (el instanceof HTMLTextAreaElement && el.closest('[data-composer]')) {
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
 * main column, which a side chat inside the right panel is not.
 */
function focusedChat(target: EventTarget | null): string | null {
  const el = target instanceof HTMLElement ? target : null
  const view = el?.closest('[data-chat-surface]')
  return view instanceof HTMLElement ? view.dataset.chatSurface || null : null
}

export function PermissionCard({
  request,
  chatId,
  keyboard = false
}: {
  request: PermissionRequestPayload
  /** The chat this prompt belongs to — a side chat is never the active one. */
  chatId: string
  /**
   * This is the prompt Enter and Esc answer. Only one card *per transcript*
   * holds the keys — the oldest pending one — and which transcript answers is
   * decided at the keypress by `focusedChat`.
   */
  keyboard?: boolean
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
        {keyboard && !busy && (
          <span className="mr-auto text-[11px] text-muted-foreground/60 select-none">
            <kbd className="font-sans">↵</kbd> allow · <kbd className="font-sans">esc</kbd> deny
          </span>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void respond({ behavior: 'deny' })}>
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
      </div>
    </div>
  )
}
