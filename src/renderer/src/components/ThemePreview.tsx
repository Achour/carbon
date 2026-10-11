import * as React from 'react'

/**
 * A scale model of Carbon's own window in one palette: sidebar, a line of text,
 * a code block, and the composer with the accent on the send button.
 *
 * These palettes are built as a *surface ladder* (sidebar → background → card →
 * code), so the ladder is what the picker should show. A single color chip says
 * nothing about the chrome that color has to live on, which is exactly how the
 * old registry shipped 22 themes that turned out to share a light mode.
 */
export function MiniWindow({ vars }: { vars: Record<string, string> }): React.JSX.Element {
  const v = (name: string): string => vars[name]
  return (
    <div className="flex h-full w-full" style={{ background: v('background') }}>
      <div
        className="flex w-[30%] shrink-0 flex-col gap-1 p-1.5"
        style={{ background: v('sidebar') }}
      >
        <div
          className="h-[3px] w-4/5 rounded-full"
          style={{ background: v('sidebar-foreground'), opacity: 0.5 }}
        />
        <div
          className="h-[3px] w-3/5 rounded-full"
          style={{ background: v('sidebar-foreground'), opacity: 0.28 }}
        />
        <div className="h-2 w-full rounded-sm" style={{ background: v('sidebar-accent') }} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-1.5">
        <div
          className="h-[3px] w-3/4 rounded-full"
          style={{ background: v('foreground'), opacity: 0.72 }}
        />
        <div
          className="h-[3px] w-1/2 rounded-full"
          style={{ background: v('muted-foreground'), opacity: 0.6 }}
        />
        <div className="h-3 w-full rounded-sm" style={{ background: v('code-bg') }} />
        <div
          className="mt-auto flex h-3 items-center justify-end rounded-sm border px-1"
          style={{ background: v('card'), borderColor: v('border') }}
        >
          <div className="size-1.5 rounded-full" style={{ background: v('primary') }} />
        </div>
      </div>
    </div>
  )
}
