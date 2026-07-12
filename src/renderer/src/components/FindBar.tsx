import * as React from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'

/** A VS Code-style find widget (⌘F) driven by Electron's native findInPage. */
export function FindBar(): React.JSX.Element | null {
  const open = useApp((s) => s.findOpen)
  const setOpen = useApp((s) => s.setFindOpen)
  const [q, setQ] = React.useState('')
  const [info, setInfo] = React.useState<{ active: number; matches: number }>({
    active: 0,
    matches: 0
  })
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => window.api.onFindResult((r) => setInfo({ active: r.activeMatchOrdinal, matches: r.matches })), [])

  React.useEffect(() => {
    if (open) {
      const t = setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 20)
      return () => clearTimeout(t)
    }
    setInfo({ active: 0, matches: 0 })
    void window.api.stopFind()
    return undefined
  }, [open])

  const search = (query: string, opts?: { forward?: boolean; findNext?: boolean }): void => {
    if (query) void window.api.findInPage(query, opts)
    else {
      void window.api.stopFind()
      setInfo({ active: 0, matches: 0 })
    }
  }

  if (!open) return null

  return (
    <div className="no-drag fixed top-14 right-6 z-50 flex items-center gap-1 rounded-lg border border-border bg-popover px-1.5 py-1 shadow-xl">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          search(e.target.value, { findNext: false })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            search(q, { forward: !e.shiftKey, findNext: true })
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
          }
        }}
        placeholder="Find"
        spellCheck={false}
        className="h-6 w-44 bg-transparent px-1.5 text-[13px] outline-none placeholder:text-muted-foreground/60"
      />
      <span className="min-w-[52px] shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">
        {q ? `${info.matches ? info.active : 0}/${info.matches}` : ''}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        className="size-6"
        aria-label="Previous match"
        onClick={() => search(q, { forward: false, findNext: true })}
      >
        <ArrowUp />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        className="size-6"
        aria-label="Next match"
        onClick={() => search(q, { forward: true, findNext: true })}
      >
        <ArrowDown />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        className="size-6"
        aria-label="Close find"
        onClick={() => setOpen(false)}
      >
        <X />
      </Button>
    </div>
  )
}
