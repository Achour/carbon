import * as React from 'react'
import { FileText, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

/** A ⌘P command palette that fuzzy-searches project files and opens one. */
export function FileSearchDialog(): React.JSX.Element {
  const open = useApp((s) => s.fileSearchOpen)
  const setOpen = useApp((s) => s.setFileSearchOpen)
  const cwd = useApp((s) => s.selectedCwd)
  const openFile = useApp((s) => s.openFile)

  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState<{ rel: string; path: string }[]>([])
  const [idx, setIdx] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) return
    setQ('')
    setResults([])
    setIdx(0)
    // Base UI moves focus into the popup; nudge it to the input.
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  React.useEffect(() => {
    if (!open || !cwd) {
      setResults([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void window.api.searchFiles(cwd, q.trim()).then((res) => {
        if (alive) {
          setResults(res)
          setIdx(0)
        }
      })
    }, 80)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q, open, cwd])

  const choose = (r: { path: string }): void => {
    void openFile(r.path)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[14%] max-w-lg translate-y-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Search files</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (!results.length) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((i) => (i + 1) % results.length)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((i) => (i - 1 + results.length) % results.length)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (results[idx]) choose(results[idx])
              }
            }}
            placeholder="Search files by name…"
            spellCheck={false}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {results.length > 0 ? (
            results.map((r, i) => {
              const name = r.rel.split('/').pop() ?? r.rel
              const dir = r.rel.slice(0, r.rel.length - name.length).replace(/\/$/, '')
              return (
                <button
                  key={r.path}
                  type="button"
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => choose(r)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
                    i === idx && 'bg-accent'
                  )}
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-[13px]">
                    <span className="text-foreground">{name}</span>
                    {dir && <span className="ml-1.5 text-muted-foreground/60">{dir}</span>}
                  </span>
                </button>
              )
            })
          ) : (
            <div className="px-2 py-8 text-center text-xs text-muted-foreground/70">
              {q.trim()
                ? `No files match “${q}”.`
                : cwd
                  ? 'Type to search files.'
                  : 'Open a project first.'}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
