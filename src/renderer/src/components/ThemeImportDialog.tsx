import * as React from 'react'
import { BadgeCheck, Check, Compass, FileUp, Search, TriangleAlert } from 'lucide-react'
import type { ThemeExtension } from '@shared/types'
import { importThemeJson, importThemeText, type ImportedTheme } from '@shared/themeImport'
import { cn } from '@/lib/utils'
import { formatCompact } from '@/lib/format'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { MiniWindow } from '@/components/ThemePreview'

/**
 * Settings → Appearance → Add theme.
 *
 * Every theme in here is *tried on* before it is kept: clicking a card repaints
 * the whole app, dialog included, and Keep is what saves it. That holds for
 * both tabs — an Open VSX result and a dropped or pasted file are the same card
 * with the same two clicks — because a thumbnail says far less about a palette
 * than the app wearing it. Conversion is `shared/themeImport.ts`.
 */

const SUGGESTIONS = ['Dracula', 'Catppuccin', 'Nord', 'Tokyo Night', 'One Dark', 'GitHub']
/** Extensions whose themes download as soon as they're listed. */
const EAGER = 3
const PAGE = 6

type Tab = 'browse' | 'import'

const TABS: { id: Tab; label: string; icon: typeof Compass }[] = [
  { id: 'browse', label: 'Browse', icon: Compass },
  { id: 'import', label: 'Import file', icon: FileUp }
]


type Variants =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; themes: ImportedTheme[] }

/** Matches `ThemeCard` in Settings, so a result reads as a theme you could have. */
function ResultCard({
  theme,
  previewing,
  kept,
  onPreview,
  onKeep
}: {
  theme: ImportedTheme
  previewing: boolean
  kept: boolean
  onPreview: () => void
  onKeep: () => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border p-2 transition-colors',
        previewing ? 'border-primary/70 bg-accent/50' : 'border-border bg-card/40 hover:bg-accent/30'
      )}
    >
      <button
        type="button"
        onClick={onPreview}
        aria-pressed={previewing}
        aria-label={`Try ${theme.name}`}
        className="h-[74px] w-full overflow-hidden rounded-lg border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MiniWindow vars={theme.vars} />
      </button>
      <div className="flex min-h-7 items-center gap-1.5 px-0.5">
        <button type="button" onClick={onPreview} className="min-w-0 flex-1 text-left outline-none">
          <span className="block truncate text-[13px] font-medium">{theme.name}</span>
          <span className="block text-[11px] text-muted-foreground capitalize">{theme.appearance}</span>
        </button>
        {kept ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Check className="size-3" /> Kept
          </span>
        ) : previewing ? (
          <Button size="sm" className="h-6 px-2" onClick={onKeep}>
            Keep
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function PlaceholderCard({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card/40 p-2">
      <div className="h-[74px] animate-pulse rounded-lg bg-muted" />
      <div className="min-h-7 px-0.5">
        <span className="block truncate text-[13px] font-medium text-muted-foreground">{label}</span>
      </div>
    </div>
  )
}

function ExtensionGroup({
  extension,
  variants,
  previewing,
  kept,
  onLoad,
  onPreview,
  onKeep
}: {
  extension: ThemeExtension
  variants: Variants | undefined
  previewing: string | null
  kept: Set<string>
  onLoad: () => void
  onPreview: (theme: ImportedTheme) => void
  onKeep: (theme: ImportedTheme) => void
}): React.JSX.Element {
  const count = extension.themes.length
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2 px-0.5">
        <span className="truncate text-[13px] font-medium">{extension.displayName}</span>
        {extension.verified && (
          <BadgeCheck className="size-3.5 shrink-0 self-center text-primary" aria-label="Verified publisher" />
        )}
        <span className="truncate text-xs text-muted-foreground">
          {extension.namespace} · {formatCompact(extension.downloads)} installs
        </span>
        {!variants && (
          <button
            type="button"
            onClick={onLoad}
            className="ml-auto shrink-0 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
          >
            Show {count === 1 ? 'theme' : `${count} themes`}
          </button>
        )}
      </div>
      {variants?.state === 'error' ? (
        <div className="flex items-center gap-1.5 px-0.5 text-xs text-destructive">
          <TriangleAlert className="size-3.5" />
          {variants.message}
          <button
            type="button"
            onClick={onLoad}
            className="ml-1 text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
          >
            Retry
          </button>
        </div>
      ) : variants ? (
        <div className="grid grid-cols-3 gap-2.5">
          {variants.state === 'loading'
            ? extension.themes.map((t, i) => <PlaceholderCard key={i} label={t.label} />)
            : variants.themes.map((theme) => {
                const key = `${extension.id}\u0000${theme.name}`
                return (
                  <ResultCard
                    key={key}
                    theme={theme}
                    previewing={previewing === key}
                    kept={kept.has(key)}
                    onPreview={() => onPreview(theme)}
                    onKeep={() => onKeep(theme)}
                  />
                )
              })}
        </div>
      ) : null}
    </div>
  )
}

/** Converts what it can and reports the rest by file, so one bad file doesn't sink a batch. */
async function readThemeFiles(files: File[]): Promise<{ themes: ImportedTheme[]; errors: string[] }> {
  const themes: ImportedTheme[] = []
  const errors: string[] = []
  for (const file of files) {
    try {
      const fallback = file.name.replace(/\.(json|jsonc)$/i, '').replace(/[-_]?color-?theme$/i, '')
      for (const theme of importThemeText(await file.text())) {
        themes.push(theme.name === 'Imported theme' ? { ...theme, name: fallback || theme.name } : theme)
      }
    } catch (err) {
      errors.push(`${file.name}: ${(err as Error).message}`)
    }
  }
  return { themes, errors }
}

const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files')


/** A file's themes, kept apart per import so a second drop doesn't replace the first. */
interface FileBatch {
  id: number
  label: string
  themes: ImportedTheme[]
}

export function ThemeImportDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(680px,86vh)] max-w-3xl flex-col p-0">
        {open && <ThemeImportBody onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function ThemeImportBody({ onDone }: { onDone: () => void }): React.JSX.Element {
  const addCustomThemes = useApp((s) => s.addCustomThemes)
  const setTheme = useApp((s) => s.setTheme)
  const previewTheme = useApp((s) => s.previewTheme)
  const [tab, setTab] = React.useState<Tab>('browse')
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<ThemeExtension[] | null>(null)
  const [shown, setShown] = React.useState(PAGE)
  const [searching, setSearching] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [variants, setVariants] = React.useState<Record<string, Variants>>({})
  const [batches, setBatches] = React.useState<FileBatch[]>([])
  const [previewing, setPreviewing] = React.useState<string | null>(null)
  const [kept, setKept] = React.useState<Set<string>>(new Set())
  const [dragging, setDragging] = React.useState(false)
  const [notice, setNotice] = React.useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const nextBatch = React.useRef(1)

  // A preview never outlives the dialog: closing it — Done, Escape, the
  // backdrop — unmounts this body, and that puts the saved theme back.
  const previewingRef = React.useRef(previewing)
  previewingRef.current = previewing
  React.useEffect(
    () => () => {
      if (previewingRef.current !== null) previewTheme(null)
    },
    [previewTheme]
  )

  const tryOn = (key: string, theme: ImportedTheme): void => {
    if (previewing === key) {
      setPreviewing(null)
      previewTheme(null)
      return
    }
    setPreviewing(key)
    previewTheme(theme)
  }

  const keep = (key: string, theme: ImportedTheme, source?: { key: string; label: string }): void => {
    const [id] = addCustomThemes([theme], source)
    setPreviewing(null)
    setTheme(id)
    setKept((s) => new Set(s).add(key))
    setNotice({ tone: 'ok', text: `Kept ${theme.name}` })
  }

  React.useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setError(null)
      setSearching(false)
      return
    }
    let live = true
    setSearching(true)
    const timer = setTimeout(() => {
      window.api
        .searchThemeExtensions(q)
        .then((rows) => {
          if (!live) return
          setResults(rows)
          setShown(PAGE)
          setError(null)
        })
        .catch((err: Error) => live && setError(err.message || 'Couldn’t reach Open VSX'))
        .finally(() => live && setSearching(false))
    }, 350)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])

  const variantsRef = React.useRef(variants)
  variantsRef.current = variants
  const load = React.useCallback((extension: ThemeExtension) => {
    const known = variantsRef.current[extension.id]
    if (known && known.state !== 'error') return
    setVariants((v) => ({ ...v, [extension.id]: { state: 'loading' } }))
    window.api
      .fetchThemeExtension(extension.id)
      .then((files) => {
        const themes: ImportedTheme[] = []
        for (const file of files) {
          try {
            themes.push(...importThemeJson(file.json, { name: file.label, appearance: file.appearance }))
          } catch {
            // One unreadable variant shouldn't hide the rest of the pack.
          }
        }
        setVariants((v) => ({
          ...v,
          [extension.id]: themes.length
            ? { state: 'ready', themes }
            : { state: 'error', message: 'None of its themes could be converted' }
        }))
      })
      .catch((err: Error) =>
        setVariants((v) => ({
          ...v,
          [extension.id]: { state: 'error', message: err.message || 'Download failed' }
        }))
      )
  }, [])

  React.useEffect(() => {
    results?.slice(0, EAGER).forEach(load)
  }, [results, load])

  /** Files and pastes land as cards to try, like a search result — not as instant saves. */
  const addBatch = React.useCallback(
    (label: string, themes: ImportedTheme[], errors: string[]) => {
      setTab('import')
      if (themes.length) {
        const id = nextBatch.current++
        setBatches((b) => [{ id, label, themes }, ...b])
        // The first one is on as soon as it lands: dropping a file is already
        // the request to see it.
        const key = `file\u0000${id}\u0000${themes[0].name}`
        setPreviewing(key)
        previewTheme(themes[0])
      }
      setNotice(errors.length ? { tone: 'error', text: errors.join(' · ') } : null)
    },
    [previewTheme]
  )

  const importFiles = React.useCallback(
    async (list: FileList | File[]): Promise<void> => {
      const files = [...list].filter((f) => /\.(json|jsonc)$/i.test(f.name) || f.type === 'application/json')
      if (files.length === 0) {
        setTab('import')
        setNotice({ tone: 'error', text: 'Only .json theme files can be imported' })
        return
      }
      const { themes, errors } = await readThemeFiles(files)
      addBatch(files.length === 1 ? files[0].name : `${files.length} files`, themes, errors)
    },
    [addBatch]
  )

  // Drop and paste work anywhere in the dialog, on either tab.
  React.useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault()
    }
    const leave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (e.dataTransfer) void importFiles(e.dataTransfer.files)
    }
    const paste = (e: ClipboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      const text = e.clipboardData?.getData('text/plain')?.trim()
      if (!text) return
      e.preventDefault()
      try {
        addBatch('Pasted', importThemeText(text), [])
      } catch (err) {
        setTab('import')
        setNotice({ tone: 'error', text: `Clipboard: ${(err as Error).message}` })
      }
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [importFiles, addBatch])

  return (
    <>
      <div className="flex items-center gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <DialogTitle>Add theme</DialogTitle>
          <DialogDescription className="mt-0.5 text-xs">
            Click a theme to try it on. Keep the ones you like.
          </DialogDescription>
        </div>
        <div role="tablist" aria-label="Source" className="grid grid-cols-2 gap-1 rounded-xl bg-secondary p-1">
          {TABS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={tab === option.id}
              onClick={() => setTab(option.id)}
              className={cn(
                'flex h-7 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring',
                tab === option.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <option.icon className="size-3.5" />
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === 'browse' ? (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // First Escape clears the search, the second closes.
                  if (e.key === 'Escape' && query) {
                    e.stopPropagation()
                    setQuery('')
                  }
                }}
                placeholder="Search VS Code themes on Open VSX"
                aria-label="Search Open VSX themes"
                className="no-drag h-9 w-full rounded-lg border border-input bg-transparent pr-9 pl-9 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              />
              {searching && (
                <div className="absolute top-1/2 right-3 -translate-y-1/2">
                  <DotSpinner />
                </div>
              )}
            </div>

            {!query.trim() ? (
              <div className="flex flex-col items-center px-6 pt-16 text-center">
                <Compass className="size-6 text-muted-foreground/60" />
                <div className="mt-3 text-[13px] font-medium">Thousands of VS Code themes</div>
                <div className="mt-1 max-w-sm text-xs text-muted-foreground">
                  Search by name. Each extension’s themes show up as cards you can try before
                  keeping.
                </div>
                <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                  {SUGGESTIONS.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setQuery(name)}
                      className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            ) : error ? (
              <div className="mt-4 flex items-center gap-1.5 text-xs text-destructive">
                <TriangleAlert className="size-3.5" />
                {error}
              </div>
            ) : results && results.length === 0 && !searching ? (
              <div className="mt-4 text-xs text-muted-foreground">
                No color themes match “{query.trim()}”.
              </div>
            ) : results ? (
              <div className="mt-5 space-y-6">
                {results.slice(0, shown).map((extension) => (
                  <ExtensionGroup
                    key={extension.id}
                    extension={extension}
                    variants={variants[extension.id]}
                    previewing={previewing}
                    kept={kept}
                    onLoad={() => load(extension)}
                    onPreview={(theme) => tryOn(`${extension.id}\u0000${theme.name}`, theme)}
                    onKeep={(theme) =>
                      keep(`${extension.id}\u0000${theme.name}`, theme, {
                        key: extension.id,
                        label: extension.displayName
                      })
                    }
                  />
                ))}
                {results.length > shown && (
                  <button
                    type="button"
                    onClick={() => setShown((n) => n + PAGE)}
                    className="text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
                  >
                    {results.length - shown} more{' '}
                    {results.length - shown === 1 ? 'extension' : 'extensions'}
                  </button>
                )}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className={cn(
                'flex w-full flex-col items-center rounded-xl border border-dashed px-6 py-8 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                dragging ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/30'
              )}
            >
              <FileUp className="size-6 text-muted-foreground/70" />
              <span className="mt-3 text-[13px] font-medium">
                {dragging ? 'Drop to import' : 'Drop theme files, or click to choose'}
              </span>
              <span className="mt-1 text-xs text-muted-foreground">
                VS Code or Carbon <code className="text-[11px]">.json</code> — or paste one
                with <kbd className="font-sans">⌘V</kbd>
              </span>
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".json,.jsonc,application/json"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void importFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <div className="mt-5 space-y-6">
              {batches.map((batch) => (
                <div key={batch.id}>
                  <div className="mb-2 px-0.5 text-[13px] font-medium">{batch.label}</div>
                  <div className="grid grid-cols-3 gap-2.5">
                    {batch.themes.map((theme) => {
                      const key = `file\u0000${batch.id}\u0000${theme.name}`
                      return (
                        <ResultCard
                          key={key}
                          theme={theme}
                          previewing={previewing === key}
                          kept={kept.has(key)}
                          onPreview={() => tryOn(key, theme)}
                          onKeep={() => keep(key, theme)}
                        />
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {dragging && tab === 'browse' && (
          <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-popover/85 text-[13px] font-medium">
            Drop to import
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-border px-5 py-3">
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 text-xs',
            notice?.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {notice && (notice.tone === 'error' ? <TriangleAlert className="size-3.5 shrink-0" /> : <Check className="size-3.5 shrink-0" />)}
          <span className="min-w-0 truncate" title={notice?.text}>
            {notice?.text ??
              (previewing ? 'Trying on — Keep it, or close to go back' : '')}
          </span>
        </div>
        <Button onClick={onDone}>Done</Button>
      </div>
    </>
  )
}
