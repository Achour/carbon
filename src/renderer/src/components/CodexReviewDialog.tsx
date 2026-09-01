import * as React from 'react'
import {
  ArrowLeft,
  FileDiff,
  GitCommitHorizontal,
  GitCompare,
  LoaderCircle,
  PenLine,
  Search
} from 'lucide-react'
import type { BranchRef, CodexReviewTarget, ReviewCommit } from '@shared/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type ReviewScreen = 'presets' | 'branch' | 'commit' | 'custom'

function Preset({
  icon,
  title,
  description,
  onClick,
  disabled
}: {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
  disabled: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex w-full items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="mt-0.5 rounded-md bg-secondary p-1.5 text-muted-foreground transition-colors group-hover:text-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  )
}

function BackButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Back to review presets"
      className="rounded-md p-1 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
    >
      <ArrowLeft className="size-4" />
    </button>
  )
}

function dateLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function CodexReviewMenu({
  open,
  onOpenChange,
  cwd,
  currentBranch,
  defaultBranch,
  onStart
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  cwd: string
  currentBranch?: string
  defaultBranch?: string
  onStart: (target: CodexReviewTarget) => Promise<void>
}): React.JSX.Element {
  const [screen, setScreen] = React.useState<ReviewScreen>('presets')
  const [branches, setBranches] = React.useState<BranchRef[]>([])
  const [commits, setCommits] = React.useState<ReviewCommit[]>([])
  const [query, setQuery] = React.useState('')
  const [instructions, setInstructions] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    setScreen('presets')
    setQuery('')
    setInstructions('')
    setLoading(false)
    setSubmitting(false)
    setError(null)
  }, [open, cwd])

  React.useEffect(() => {
    if (!open) return undefined
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!submitting && !menuRef.current?.contains(event.target as Node)) onOpenChange(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault()
        onOpenChange(false)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [open, submitting, onOpenChange])

  React.useEffect(() => {
    if (!open || screen !== 'branch') return undefined
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.api
      .gitLocalBranches(cwd)
      .then((refs) => {
        if (cancelled) return
        const available = refs.filter((ref) => ref.name !== currentBranch)
        available.sort((a, b) => {
          if (a.name === defaultBranch) return -1
          if (b.name === defaultBranch) return 1
          return 0
        })
        setBranches(available)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, screen, cwd, currentBranch, defaultBranch])

  React.useEffect(() => {
    if (!open || screen !== 'commit') return undefined
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.api
      .gitReviewCommits(cwd)
      .then((values) => {
        if (!cancelled) setCommits(values)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, screen, cwd])

  const start = async (target: CodexReviewTarget): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      await onStart(target)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  const lowerQuery = query.trim().toLowerCase()
  const visibleBranches = lowerQuery
    ? branches.filter((branch) => branch.name.toLowerCase().includes(lowerQuery))
    : branches
  const visibleCommits = lowerQuery
    ? commits.filter(
        (commit) =>
          commit.sha.toLowerCase().startsWith(lowerQuery) ||
          commit.shortSha.toLowerCase().startsWith(lowerQuery) ||
          commit.subject.toLowerCase().includes(lowerQuery) ||
          commit.author.toLowerCase().includes(lowerQuery)
      )
    : commits
  const typedSha = query.trim()
  const validTypedSha = /^[0-9a-f]{4,64}$/i.test(typedSha)

  const enterScreen = (next: ReviewScreen): void => {
    setScreen(next)
    setQuery('')
    setError(null)
  }

  if (!open) return <></>

  return (
    <div
      ref={menuRef}
      role="dialog"
      aria-modal="false"
      aria-label="Codex review presets"
      className="absolute bottom-full left-3 z-40 mb-2 max-h-[min(34rem,calc(100vh-6rem))] w-[500px] max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-border bg-popover p-4 shadow-2xl animate-enter"
    >
        <div className="flex items-start gap-2">
          {screen !== 'presets' && (
            <BackButton
              disabled={submitting}
              onClick={() => enterScreen('presets')}
            />
          )}
          <div>
            <h2 className="text-sm font-semibold">
              {screen === 'presets'
                ? 'Select a review preset'
                : screen === 'branch'
                  ? 'Review against a base branch'
                  : screen === 'commit'
                    ? 'Review a commit'
                    : 'Custom review instructions'}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {screen === 'presets'
                ? 'Codex will run its native reviewer in this conversation.'
                : screen === 'branch'
                  ? 'Review the current work as a pull-request-style diff against a branch.'
                  : screen === 'commit'
                    ? 'Choose a recent commit, or paste a commit SHA.'
                    : 'Tell Codex exactly what the native reviewer should inspect.'}
            </p>
          </div>
        </div>

        {screen === 'presets' && (
          <div className="mt-4 space-y-2">
            <Preset
              icon={<GitCompare />}
              title="Review against a base branch (PR Style)"
              description="Compare the current branch and working tree with a base branch."
              disabled={submitting}
              onClick={() => enterScreen('branch')}
            />
            <Preset
              icon={<FileDiff />}
              title="Review uncommitted changes"
              description="Review staged, unstaged, and untracked changes in the working tree."
              disabled={submitting}
              onClick={() => void start({ type: 'uncommittedChanges' })}
            />
            <Preset
              icon={<GitCommitHorizontal />}
              title="Review a commit"
              description="Run the reviewer against one specific Git commit."
              disabled={submitting}
              onClick={() => enterScreen('commit')}
            />
            <Preset
              icon={<PenLine />}
              title="Custom review instructions"
              description="Provide free-form scope or review criteria."
              disabled={submitting}
              onClick={() => enterScreen('custom')}
            />
          </div>
        )}

        {screen === 'branch' && (
          <div className="mt-4 space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && query.trim()) {
                    event.preventDefault()
                    void start({ type: 'baseBranch', branch: query.trim() })
                  }
                }}
                placeholder="Search or enter a branch"
                className="pl-8"
                disabled={submitting}
              />
            </div>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-border p-1">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" /> Loading branches…
                </div>
              ) : visibleBranches.length ? (
                visibleBranches.map((branch) => (
                  <button
                    key={branch.name}
                    type="button"
                    onClick={() => void start({ type: 'baseBranch', branch: branch.name })}
                    disabled={submitting}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
                  >
                    <GitCompare className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                    {branch.name === defaultBranch && (
                      <span className="text-[10px] text-muted-foreground">default</span>
                    )}
                  </button>
                ))
              ) : (
                <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                  {query.trim() ? 'No matching local branches.' : 'No other local branches found.'}
                </p>
              )}
            </div>
            <div className="flex justify-end">
              <Button
                disabled={!query.trim() || submitting}
                onClick={() => void start({ type: 'baseBranch', branch: query.trim() })}
              >
                {submitting && <LoaderCircle className="animate-spin" />}
                Review branch
              </Button>
            </div>
          </div>
        )}

        {screen === 'commit' && (
          <div className="mt-4 space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && validTypedSha) {
                    event.preventDefault()
                    void start({ type: 'commit', sha: typedSha, title: null })
                  }
                }}
                placeholder="Search commits or paste SHA"
                className="pl-8 font-mono"
                disabled={submitting}
              />
            </div>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border p-1">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" /> Loading commits…
                </div>
              ) : visibleCommits.length ? (
                visibleCommits.map((commit) => (
                  <button
                    key={commit.sha}
                    type="button"
                    onClick={() =>
                      void start({ type: 'commit', sha: commit.sha, title: commit.subject })
                    }
                    disabled={submitting}
                    className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
                  >
                    <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        {commit.subject || '(no subject)'}
                      </span>
                      <span className="mt-0.5 flex gap-2 text-[10px] text-muted-foreground">
                        <span className="font-mono">{commit.shortSha}</span>
                        <span className="truncate">{commit.author}</span>
                        <span>{dateLabel(commit.authoredAt)}</span>
                      </span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                  {query.trim() ? 'No matching commits.' : 'No commits found.'}
                </p>
              )}
            </div>
            {query.trim() && (
              <div className="flex items-center justify-between gap-3">
                <p
                  className={cn(
                    'text-xs text-muted-foreground',
                    !validTypedSha && 'text-destructive'
                  )}
                >
                  {validTypedSha ? 'Use the typed commit SHA directly.' : 'Enter a hexadecimal commit SHA.'}
                </p>
                <Button
                  disabled={!validTypedSha || submitting}
                  onClick={() => void start({ type: 'commit', sha: typedSha, title: null })}
                >
                  {submitting && <LoaderCircle className="animate-spin" />}
                  Review SHA
                </Button>
              </div>
            )}
          </div>
        )}

        {screen === 'custom' && (
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (instructions.trim()) {
                void start({ type: 'custom', instructions: instructions.trim() })
              }
            }}
          >
            <textarea
              autoFocus
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={4_000}
              rows={6}
              placeholder="For example: Focus on authentication regressions and missing tests."
              disabled={submitting}
              className="no-drag block w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2.5 text-sm outline-none select-text placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">
                {instructions.length.toLocaleString()} / 4,000
              </span>
              <Button type="submit" disabled={!instructions.trim() || submitting}>
                {submitting && <LoaderCircle className="animate-spin" />}
                Start review
              </Button>
            </div>
          </form>
        )}

        {error && (
          <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
    </div>
  )
}
