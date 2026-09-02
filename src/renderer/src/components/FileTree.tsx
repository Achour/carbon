import * as React from 'react'
import {
  ChevronRight,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  PenLine,
  Trash2,
  RefreshCw,
  Search
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { basename } from '@/lib/format'
import { FileIcon } from '@/lib/fileIcon'
import { GIT_STATUS_COLOR } from '@/lib/gitStatusColor'
import { REVEAL_LABEL } from '@/lib/platform'
import { handleTreeKeyDown } from '@/lib/treeKeyNav'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { WithTooltip } from '@/components/ui/tooltip'

/**
 * Which rows git has something to say about, resolved once per status refresh.
 *
 * `files` is keyed by absolute path so a row is a Map hit rather than a scan,
 * and `dirs` holds every ancestor of a changed file — a collapsed folder is the
 * only place the change would otherwise be invisible, which is exactly when you
 * need to know it's in there. Repo-relative paths are joined onto the tree root
 * the same way `openDiff` does it: the app already treats the selected folder
 * as the repo root everywhere it shells out to git.
 */
interface TreeDeco {
  files: Map<string, string>
  dirs: Set<string>
}

/**
 * The "name it" row — one component for creating and for renaming, because they
 * are the same interaction with a different starting value.
 *
 * Inline rather than a dialog because the name is only half the decision — the
 * other half is *where*, and a modal takes the tree off screen at the moment
 * that matters. Sitting in the tree, the row shows its own answer: the
 * indentation is the parent folder.
 */
function NameRow({
  depth,
  kind,
  initial = '',
  error,
  placeholder,
  onCommit,
  onCancel
}: {
  depth: number
  kind: 'file' | 'dir'
  /** Prefilled for a rename; empty for a create. */
  initial?: string
  error?: string
  placeholder: string
  onCommit: (name: string) => Promise<boolean>
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    // Select the base name and leave the extension out of it: renaming is
    // almost always renaming the *name*, and having to arrow past `.tsx` every
    // time is the kind of small tax that makes a feature feel unfinished.
    const dot = initial.lastIndexOf('.')
    if (dot > 0) el.setSelectionRange(0, dot)
    else el.select()
  }, [initial])

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (busy) return
    // Nothing typed, or nothing changed — treat as "never mind" rather than as
    // an error the user has to dismiss.
    if (!trimmed || trimmed === initial) {
      onCancel()
      return
    }
    setBusy(true)
    await onCommit(trimmed)
    setBusy(false)
  }

  return (
    <div style={{ paddingLeft: 6 + depth * 14 }} className="pr-2">
      <div className="flex items-center gap-1.5 py-[3px]">
        <span className="w-3 shrink-0" />
        {kind === 'dir' ? (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FileIcon path={name || 'untitled'} />
        )}
        <input
          ref={inputRef}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          // Blur commits rather than cancels: clicking away from a name you
          // just typed reads as "done", and losing it would be the surprise.
          onBlur={() => void submit()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-sm border border-primary/60 bg-background px-1 py-px text-[length:var(--ui-row)] outline-none"
        />
      </div>
      {error && <div className="pb-1 pl-[26px] text-[length:var(--ui-row)] text-warning">{error}</div>}
    </div>
  )
}

/** The create row for `dir`, wired to `pendingCreate`. */
function CreateRow({ depth }: { depth: number }): React.JSX.Element | null {
  const pending = useApp((s) => s.pendingCreate)
  const cancelCreate = useApp((s) => s.cancelCreate)
  const commitCreate = useApp((s) => s.commitCreate)
  if (!pending) return null
  return (
    <NameRow
      depth={depth}
      kind={pending.kind}
      error={pending.error}
      placeholder={pending.kind === 'dir' ? 'folder name' : 'file name'}
      onCommit={commitCreate}
      onCancel={cancelCreate}
    />
  )
}

function TreeNode({
  dir,
  depth,
  deco
}: {
  dir: string
  depth: number
  deco: TreeDeco
}): React.JSX.Element | null {
  const entries = useApp((s) => s.filesByDir[dir])
  const expandedDirs = useApp((s) => s.expandedDirs)
  const toggleDir = useApp((s) => s.toggleDir)
  const openFile = useApp((s) => s.openFile)
  const activeTab = useApp((s) => s.activeTab)
  const addAttachment = useApp((s) => s.addAttachment)
  const beginCreate = useApp((s) => s.beginCreate)
  const creatingHere = useApp((s) => s.pendingCreate?.parent === dir)
  const confirmDelete = useApp((s) => s.confirmDelete)
  const beginRename = useApp((s) => s.beginRename)
  const renaming = useApp((s) => s.pendingRename)
  const commitRename = useApp((s) => s.commitRename)
  const cancelRename = useApp((s) => s.cancelRename)

  if (!entries) {
    return (
      <div
        className="py-1 text-[length:var(--ui-row)] text-muted-foreground/60"
        style={{ paddingLeft: 14 + depth * 14 }}
      >
        Loading…
      </div>
    )
  }

  if (entries.length === 0) {
    if (creatingHere) return <CreateRow depth={depth} />
    if (depth === 0) {
      return <div className="px-3 py-2 text-xs text-muted-foreground">This folder is empty.</div>
    }
    return null
  }

  return (
    <>
      {/* At the top of the folder rather than in sorted position: the row has no
          name yet, so it has no place in the sort, and a row that jumped as you
          typed would be worse than one that simply waits at the top. */}
      {creatingHere && <CreateRow depth={depth} />}
      {entries.map((entry) => {
        const expanded = entry.kind === 'dir' && expandedDirs[entry.path]
        const dotfile = entry.name.startsWith('.')
        const status = entry.kind === 'file' ? deco.files.get(entry.path) : undefined
        // A folder's own dot is redundant once it's open — the changed rows are
        // right there — so it marks what's still hidden.
        const buried = entry.kind === 'dir' && !expanded && deco.dirs.has(entry.path)
        if (renaming?.path === entry.path) {
          return (
            <NameRow
              key={entry.path}
              depth={depth}
              kind={entry.kind}
              initial={entry.name}
              error={renaming.error}
              placeholder={entry.name}
              onCommit={commitRename}
              onCancel={cancelRename}
            />
          )
        }
        return (
          <React.Fragment key={entry.path}>
            <ContextMenu>
              <ContextMenuTrigger render={<div />}>
                <button
                  type="button"
                  data-tree-row
                  data-kind={entry.kind}
                  data-expanded={entry.kind === 'dir' ? Boolean(expanded) : undefined}
                  onClick={() =>
                    entry.kind === 'dir'
                      ? toggleDir(entry.path)
                      : void openFile(entry.path, { preview: true })
                  }
                  onDoubleClick={() => {
                    if (entry.kind === 'file') void openFile(entry.path)
                  }}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[length:var(--ui-row)] transition-colors outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-primary/50',
                    activeTab === entry.path && 'bg-accent',
                    (dotfile || entry.ignored) && 'opacity-60'
                  )}
                  style={{ paddingLeft: 6 + depth * 14 }}
                >
                  {entry.kind === 'dir' ? (
                    <>
                      <ChevronRight
                        className={cn(
                          'size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150',
                          expanded && 'rotate-90'
                        )}
                      />
                      {expanded ? (
                        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                    </>
                  ) : (
                    <>
                      <span className="w-3 shrink-0" />
                      <FileIcon path={entry.name} />
                    </>
                  )}
                  <span className={cn('truncate', status && GIT_STATUS_COLOR[status])}>
                    {entry.name}
                  </span>
                  {buried && (
                    <span
                      className="ml-auto size-1.5 shrink-0 rounded-full bg-amber-500/70"
                      title="Contains uncommitted changes"
                    />
                  )}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                {entry.kind === 'file' && (
                  <>
                    {/* Lands in the composer as a `file` attachment — the same shape an
                        @-mention produces, so the agent gets the path to read. */}
                    <ContextMenuItem
                      onClick={() =>
                        addAttachment({
                          id: crypto.randomUUID(),
                          kind: 'file',
                          name: entry.name,
                          path: entry.path
                        })
                      }
                    >
                      <MessageSquarePlus /> Add to chat
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                  </>
                )}
                {/* On a folder these create *inside* it; on a file, beside it —
                    which is what "new file here" means when you right-click a
                    file, and it saves aiming at the folder row above. */}
                <ContextMenuItem
                  onClick={() => beginCreate(entry.kind === 'dir' ? entry.path : dir, 'file')}
                >
                  <FilePlus /> New File
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => beginCreate(entry.kind === 'dir' ? entry.path : dir, 'dir')}
                >
                  <FolderPlus /> New Folder
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => void window.api.revealPath(entry.path)}>
                  <FolderOpen /> {REVEAL_LABEL}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => beginRename({ path: entry.path, kind: entry.kind })}>
                  <PenLine /> Rename
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  destructive
                  onClick={() => confirmDelete({ path: entry.path, kind: entry.kind })}
                >
                  <Trash2 /> Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {expanded && <TreeNode dir={entry.path} depth={depth + 1} deco={deco} />}
          </React.Fragment>
        )
      })}
    </>
  )
}

export function FileTree(): React.JSX.Element {
  const cwd = useApp((s) => s.selectedCwd)
  const loaded = useApp((s) => (s.selectedCwd ? Boolean(s.filesByDir[s.selectedCwd]) : false))
  const changes = useApp((s) => s.git?.changes)
  const loadDir = useApp((s) => s.loadDir)
  const refreshFiles = useApp((s) => s.refreshFiles)
  const setFileSearchOpen = useApp((s) => s.setFileSearchOpen)
  const beginCreate = useApp((s) => s.beginCreate)
  const cancelCreate = useApp((s) => s.cancelCreate)
  const cancelRename = useApp((s) => s.cancelRename)
  const [refreshing, setRefreshing] = React.useState(false)

  const deco = React.useMemo<TreeDeco>(() => {
    const files = new Map<string, string>()
    const dirs = new Set<string>()
    if (!cwd || !changes) return { files, dirs }
    for (const change of changes) {
      const abs: string = `${cwd}/${change.path}`
      // A file staged *and* dirty appears twice; the first letter (the staged
      // one, per the porcelain parse) wins, so the row doesn't flicker meaning.
      if (!files.has(abs)) files.set(abs, change.status)
      let parent: string = abs.slice(0, abs.lastIndexOf('/'))
      while (parent.length > cwd.length && parent.startsWith(cwd)) {
        if (dirs.has(parent)) break // this whole chain is already marked
        dirs.add(parent)
        parent = parent.slice(0, parent.lastIndexOf('/'))
      }
    }
    return { files, dirs }
  }, [cwd, changes])

  React.useEffect(() => {
    if (cwd && !loaded) void loadDir(cwd)
  }, [cwd, loaded, loadDir])

  // A row left open after the project changes points at a path that is no
  // longer on screen, and the next Enter would act there.
  React.useEffect(() => {
    cancelCreate()
    cancelRename()
  }, [cwd, cancelCreate, cancelRename])

  if (!cwd) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        Open a project to browse its files.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 px-3 pt-1 pb-1.5">
        <span className="truncate text-[length:var(--ui-row)] text-muted-foreground">
          {basename(cwd)}
        </span>
        <div className="flex-1" />
        <WithTooltip label="New file">
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-5"
            aria-label="New file"
            onClick={() => beginCreate(cwd, 'file')}
          >
            <FilePlus />
          </Button>
        </WithTooltip>
        <WithTooltip label="New folder">
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-5"
            aria-label="New folder"
            onClick={() => beginCreate(cwd, 'dir')}
          >
            <FolderPlus />
          </Button>
        </WithTooltip>
        <WithTooltip label="Search files  ⌘P">
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-5"
            aria-label="Search files"
            onClick={() => setFileSearchOpen(true)}
          >
            <Search />
          </Button>
        </WithTooltip>
        <WithTooltip label="Refresh files">
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-5"
            aria-label="Refresh files"
            onClick={() => {
              setRefreshing(true)
              void refreshFiles().finally(() => setRefreshing(false))
            }}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
          </Button>
        </WithTooltip>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 outline-none"
        tabIndex={0}
        role="tree"
        onKeyDown={handleTreeKeyDown}
      >
        <TreeNode dir={cwd} depth={0} deco={deco} />
      </div>

    </div>
  )
}
