import * as React from 'react'
import type { ToolPart } from '@shared/types'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/Markdown'
import { SubAgentStream } from '@/components/messages/ToolCard'

/**
 * A sub-agent's work, read top to bottom: its stream, then its report — the
 * body of the agent's page (`AgentPane`). It follows a working agent the way
 * the transcript follows a streaming turn. `lead` is drawn above the stream —
 * the page puts the prompt there.
 */
export const AgentStreamBody = React.memo(function AgentStreamBody({
  part,
  cwd,
  live,
  running,
  lead,
  className,
  columnClassName
}: {
  part: ToolPart
  cwd: string
  /** The spawning part is still open: held running for the agent's whole life. */
  live: boolean
  running: boolean
  lead?: React.ReactNode
  className?: string
  /** The measured content column — the reading column, on a full page. */
  columnClassName?: string
}): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const columnRef = React.useRef<HTMLDivElement>(null)
  const pinnedRef = React.useRef(true)
  const children = (part.children ?? []).filter(Boolean)
  const hasText = children.some((c) => c.type === 'text' && c.text.trim())
  // Follow a working agent, the way the transcript follows a streaming turn —
  // and for the same reason, since this is that problem one level down: the
  // step it is on is the answer, and it is at the bottom. Keyed on the column's
  // *height* rather than on the store, so a group animating open or a late
  // image counts; `pinnedRef` is the only guard, so scrolling up to read
  // something stops the follow until you come back. Switching agents re-pins:
  // arriving at the top of a 42-step stream is arriving at its oldest news.
  React.useEffect(() => {
    pinnedRef.current = true
    // Only a *working* agent opens at its end. A settled one is a document,
    // and landing on the last line of a document you have not read is the
    // wrong end of it — its report is a scroll away, where a report goes.
    const el = scrollRef.current
    if (el) el.scrollTop = live ? el.scrollHeight : 0
    // `live` is deliberately not a dependency: this is the *arrival* rule, and
    // re-running it when the agent finishes would yank the reader to the top of
    // whatever they were reading.
  }, [part.toolUseId])
  React.useEffect(() => {
    const scroller = scrollRef.current
    const column = columnRef.current
    if (!scroller || !column) return
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current && live) scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(column)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [live])
  // Fires per scroll event, so the pin is a ref and nothing is written.
  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  return (
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={cn('min-h-0 flex-1 overflow-y-auto px-3 py-3', className)}
      >
        {/* The measured element is the content, not the scroller: a
            ResizeObserver on a scroller reports the viewport, which does not
            move when the stream grows. */}
        <div ref={columnRef} className={columnClassName}>
          {lead}
          {children.length > 0 ? (
            <SubAgentStream parts={children} cwd={cwd} live={live} />
          ) : (
            <div className="text-[13px] text-muted-foreground">
              {running ? 'Starting…' : 'No activity recorded.'}
            </div>
          )}
          {/* The agent's report to the model that spawned it — the one thing the
              roster row cannot carry, and usually the thing being looked for. */}
          {/* Skipped when the stream already ends on the agent's own words
              and the output is that same report — Claude's and Codex's do —
              but kept for a provider that streams nothing (Grok, Antigravity),
              where it is the whole of what the agent said. */}
          {part.output != null && part.output !== '' && !(hasText && sameReport(children, part.output)) && (
            <div className="mt-3 rounded-lg border border-border bg-code p-2.5">
              <div className="mb-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                Result
              </div>
              <div className="text-[13px] leading-relaxed">
                <Markdown text={part.output} cwd={cwd} />
              </div>
            </div>
          )}
        </div>
      </div>
  )
})

/** The stream's last words are the output — don't print the report twice. */
function sameReport(children: ToolPart['children'] & object, output: string): boolean {
  const last = [...children].reverse().find((c) => c?.type === 'text' && c.text.trim())
  if (!last || last.type !== 'text') return false
  const a = last.text.replace(/\s+/g, ' ').trim()
  const b = output.replace(/\s+/g, ' ').trim()
  // Equal, not "contains": a short line streamed first ("Done.") would
  // otherwise hide a longer report that merely begins with it.
  return a === b
}
