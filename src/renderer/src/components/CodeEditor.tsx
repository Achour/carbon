import * as React from 'react'
import { CircleAlert, MessageSquarePlus, TriangleAlert } from 'lucide-react'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  standardKeymap
} from '@codemirror/commands'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit
} from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import {
  forEachDiagnostic,
  lintKeymap,
  openLintPanel,
  setDiagnosticsEffect
} from '@codemirror/lint'
import { SELECTION_MAX_CHARS, type Attachment, type FileContent } from '@shared/types'
import { useApp } from '@/store'
import { editorTheme } from '@/lib/editorTheme'
import { diagnostics } from '@/lib/editorDiagnostics'
import { loadLanguage, loadedLanguage } from '@/lib/editorLanguage'
import { lineSelection, selectionLabel, trimTrailingNewlines } from '@/lib/codeSelection'
import { basename } from '@/lib/format'
import { cn, editorNotice } from '@/lib/utils'
import {
  createBuffer,
  getBuffer,
  registerView,
  scrollTop,
  viewForPath,
  setScrollTop,
  syncBuffer,
  unregisterView
} from '@/lib/editorBuffers'
import { lspExtension, jumpToDefinitionAt, jumpFailure, type JumpResult } from '@/lib/lspClient'

const PILL_HEIGHT = 28
const GAP = 6

interface Anchor {
  top: number
  left: number
  /** 1-based inclusive, for the label only — the text is cut at click time. */
  startLine: number
  endLine: number
}

/**
 * A one-line answer to a ⌘-click that went nowhere, placed at the symbol the
 * user clicked. Transient and unclickable: it explains a gesture rather than
 * asking for one, so it must not become chrome that outlives the question.
 */
interface Notice {
  top: number
  left: number
  text: string
}

/** Long enough to read a short sentence, short enough not to linger. */
const NOTICE_MS = 4000

/**
 * Compartments let a mounted view be reconfigured without being rebuilt. Only
 * the two things that arrive *after* first paint need one — the language (lazy
 * grammar `import()`) and the LSP connection (spawning a process). Read-only
 * ness is known at creation and is a plain extension.
 */
const language = new Compartment()
const lsp = new Compartment()

/**
 * Extensions that never change for the life of a buffer. Takes the path rather
 * than callbacks so nothing but a string is captured into the long-lived state
 * — see `addSelectionToChat`.
 */
function baseExtensions(path: string): Extension {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of('  '),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true, closeOnBlur: true }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    // Syntax errors come from the grammar, so they work with no language
    // server installed; type errors join them when one is connected.
    diagnostics,
    // CodeMirror's default is that ⌘-click (⌃ off macOS) adds a selection range.
    // That is the chord go-to-definition uses, so left alone a jump also leaves
    // a stray cursor behind. Alt-click takes over multi-cursor, which is what
    // VS Code and Zed bind it to anyway.
    EditorView.clickAddsSelectionRange.of((e) => e.altKey),
    // `top: true` puts the search panel where FindBar sits for every other tab,
    // so ⌘F looks like one feature rather than two.
    search({ top: true }),
    keymap.of([
      // Ours first — ⌘S and ⌘L must win over anything below them.
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          void useApp.getState().saveFile(path)
          return true
        }
      },
      { key: 'Mod-l', preventDefault: true, run: () => addSelectionToChat(path) },
      ...closeBracketsKeymap,
      ...standardKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      ...defaultKeymap,
      indentWithTab
    ]),
    editorTheme
  ]
}

/**
 * "Add to chat" for the current selection, resolved entirely from `path`.
 *
 * Module scope rather than a component callback, because this is reached from
 * the ⌘L keybinding — and that keymap is baked into an `EditorState` that
 * deliberately outlives the component. A closure over component scope would
 * keep the unmounted fiber and the *mount-time* `FileContent` alive for as long
 * as the tab is open: a second, stale copy of the file (up to `MAX_TEXT_BYTES`)
 * per open tab, held from the first save until the tab closes.
 */
export function addSelectionToChat(path: string): boolean {
  const view = viewForPath(path)
  if (!view) return false
  const { from, to } = view.state.selection.main
  // CodeMirror hands back character offsets into the document, which is exactly
  // what `lineSelection` already took from the old DOM measurement — so the
  // arithmetic (and its tests) carry over untouched. This is the one place the
  // document is materialized, and it runs on a click rather than per frame.
  const sel = lineSelection(view.state.doc.toString(), from, to, SELECTION_MAX_CHARS)
  if (!sel) return false
  const app = useApp.getState()
  const cwd = app.selectedCwd
  const file = app.fileContents[path]
  const language = file?.kind === 'text' ? file.language : undefined
  const rel = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : undefined
  app.addAttachment({
    id: crypto.randomUUID(),
    kind: 'selection',
    name: selectionLabel(basename(path), sel.startLine, sel.endLine),
    selection: {
      path,
      ...(rel ? { rel } : {}),
      startLine: sel.startLine,
      endLine: sel.endLine,
      text: sel.text,
      ...(language ? { language } : {}),
      ...(sel.truncated ? { truncated: true } : {})
    }
  })
  // The lines are in the composer now; leaving them highlighted (and the pill
  // over them) reads as though the click did nothing. Collapsing the selection
  // dispatches a transaction, which is what takes the pill down.
  view.dispatch({ selection: { anchor: view.state.selection.main.head } })
  return true
}

/**
 * Why a ⌘-click produced no jump, in one sentence.
 *
 * The distinction that matters is *unavailable* versus *absent*: a missing
 * language server means no symbol in the file will ever resolve and there is
 * something the user can do about it, where a symbol with no definition is a
 * normal answer about that one click. Collapsing the two — which is what
 * silence did — makes a working feature look broken.
 */
function jumpNoticeText(path: string): string {
  const failure = jumpFailure(path)
  if (!failure) return 'No definition found.'
  switch (failure.kind) {
    case 'not-installed':
      return `No language server installed — run “${failure.install}” for go to definition.`
    case 'failed':
      return 'The language server for this project failed to start.'
    default: {
      const ext = basename(path).slice(basename(path).lastIndexOf('.'))
      return `No language server for ${ext || 'this'} files.`
    }
  }
}

export const CodeEditor = React.memo(function CodeEditor({
  content,
  path
}: {
  content: Extract<FileContent, { kind: 'text' }>
  /** Absolute path on disk. Buffers, saves and LSP are all keyed by it. */
  path: string
}): React.JSX.Element {
  const fileName = basename(path)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  const [anchor, setAnchor] = React.useState<Anchor | null>(null)
  // Errors below the fold are invisible — a squiggle only says something about
  // the lines you happen to be looking at. The counts are read off the state
  // rather than tracked incrementally, but only when a diagnostics effect
  // actually lands, which is once per server push rather than per keystroke.
  const [problems, setProblems] = React.useState({ errors: 0, warnings: 0 })
  const [notice, setNotice] = React.useState<Notice | null>(null)
  const anchorRef = React.useRef<Anchor | null>(null)
  anchorRef.current = anchor
  const noticeTimer = React.useRef(0)
  // Whether a language server is actually behind this editor. A ref rather than
  // state: it is read from DOM listeners baked into the mount effect, and it
  // flips once, long after the render that would have consumed it.
  const lspReady = React.useRef(false)

  const showNotice = React.useCallback((text: string, clientX: number, clientY: number): void => {
    const host = hostRef.current
    if (!host) return
    const box = host.getBoundingClientRect()
    window.clearTimeout(noticeTimer.current)
    setNotice({ top: clientY - box.top + GAP * 2, left: Math.max(0, clientX - box.left), text })
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
  }, [])

  // Position the pill in the scroller's own coordinates so it travels with the
  // code. Recomputed on scroll (one `coordsAtPos`, a cheap DOM measure) rather
  // than pinned to the viewport, which would detach it from the lines it names
  // on the first wheel tick.
  const place = React.useCallback((): void => {
    const view = viewRef.current
    const host = hostRef.current
    if (!view || !host) return
    const range = view.state.selection.main
    if (range.empty) {
      setAnchor(null)
      return
    }
    // Line numbers come off the rope in O(log n). Running `lineSelection` here
    // instead would mean `doc.toString()` — a full copy of the document — on
    // every mousemove of a drag and every shift+arrow, which on a 2 MB file is
    // a megabyte-scale allocation per frame. The pill only needs its label; the
    // text is cut once, in `addSelectionToChat`, when the click happens.
    const doc = view.state.doc
    // The same back-off `lineSelection` applies, read off the rope a character
    // at a time rather than off a materialized copy of the document — the label
    // is recomputed on every mousemove of a drag.
    const end = trimTrailingNewlines(range.from, range.to, (i) =>
      doc.sliceString(i, i + 1).charCodeAt(0)
    )
    const startLine = doc.lineAt(range.from).number
    const endLine = doc.lineAt(Math.max(range.from, end)).number
    const coords = view.coordsAtPos(range.head) ?? view.coordsAtPos(range.to)
    if (!coords) {
      setAnchor(null)
      return
    }
    const box = host.getBoundingClientRect()
    const above = coords.top - box.top - PILL_HEIGHT - GAP
    setAnchor({
      top: above >= 0 ? above : coords.bottom - box.top + GAP,
      left: Math.max(0, coords.left - box.left),
      startLine,
      endLine
    })
  }, [])

  // ---- Mount: one EditorView for the life of this tab ----
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let buf = getBuffer(path)
    if (!buf) {
      // A truncated read is displayable but never saveable: writing it back
      // would put the head of the file over the whole of it, so the state goes
      // in read-only and `saveFile` reads that back off CodeMirror.
      const known = loadedLanguage(fileName, content.language)
      buf = createBuffer(path, {
        text: content.content,
        mtimeMs: content.mtimeMs,
        extensions: [
          baseExtensions(path),
          language.of(known ? known : []),
          lsp.of([]),
          content.truncated
            ? [EditorView.editable.of(false), EditorState.readOnly.of(true)]
            : []
        ]
      })
    }

    const view = new EditorView({
      state: buf.state,
      parent: host,
      dispatchTransactions: (trs, v) => {
        v.update(trs)
        // Persist the new state so a tab switch (which unmounts this view)
        // keeps undo history, cursor and scroll.
        syncBuffer(
          path,
          v.state,
          trs.some((tr) => tr.docChanged)
        )
        if (trs.some((tr) => tr.selection || tr.docChanged)) place()
        if (trs.some((tr) => tr.effects.some((e) => e.is(setDiagnosticsEffect)))) {
          let errors = 0
          let warnings = 0
          forEachDiagnostic(v.state, (d) => {
            if (d.severity === 'error') errors++
            else if (d.severity === 'warning') warnings++
          })
          setProblems({ errors, warnings })
        }
      }
    })
    viewRef.current = view
    registerView(path, view)

    // Restore scroll position across a tab switch. CodeMirror measures on the
    // next frame, so this has to wait for it.
    const savedScroll = scrollTop(path)
    if (savedScroll) {
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = savedScroll
      })
    }

    let frame = 0
    const onScroll = (): void => {
      setScrollTop(path, view.scrollDOM.scrollTop)
      // The notice points at a line; it is positioned against the host, so
      // scrolling would leave it pointing at whatever moved underneath.
      setNotice(null)
      if (!anchorRef.current || frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        place()
      })
    }
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })

    // ⌘-click (⌃-click off macOS) jumps to a definition; holding the key arms
    // the pointer. Wired here rather than in its own effect because it has the
    // same lifetime as the view and would otherwise be a second effect with
    // identical deps, reading `view` back off a ref and silently depending on
    // having run second.
    const runJump = (clientX: number, clientY: number): void => {
      const report = (result: JumpResult): void => {
        if (result === 'jumped') return
        showNotice(result === 'none' ? 'No definition found.' : jumpNoticeText(path), clientX, clientY)
      }
      if (lspReady.current) {
        void jumpToDefinitionAt(view).then(report)
        return
      }
      // There was no server when this tab mounted — but there may be one now.
      // A fresh worktree is opened while `setup.sh` is still installing, so the
      // project's own server appears a minute after its first file does, and
      // answering from the mount-time "no" would keep saying "not installed"
      // about a server sitting on disk. Re-probing is a few `stat`s.
      void connectLsp().then((ok) => {
        if (ok) void jumpToDefinitionAt(view).then(report)
        else report('unavailable')
      })
    }
    const onJumpClick = (e: MouseEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      if (pos == null) return
      e.preventDefault()
      // The jump reads the selection head, so the click has to land there
      // first — a ⌘-click does not move the cursor by itself.
      view.dispatch({ selection: { anchor: pos } })
      // Read the coordinates off the event now: the answer arrives a round trip
      // to the server later, by which point `e` has been recycled.
      runJump(e.clientX, e.clientY)
    }
    // F12, the same jump from the keyboard. On `host` rather than in the
    // editor's keymap so it can place the notice, which the keymap's `Command`
    // signature has no way to reach — and a jump that explains itself on a
    // click but not on a keypress is the silence this just removed.
    const onJumpF12 = (e: KeyboardEvent): void => {
      if (e.key !== 'F12' || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      const coords = view.coordsAtPos(view.state.selection.main.head)
      runJump(coords?.left ?? 0, coords?.bottom ?? 0)
    }
    // Arming only when something can answer. A pointer that turns into a hand
    // over every identifier in a project with no language server is an
    // affordance that lies — it promises a jump on every symbol and delivers
    // none, which is most of why this looked broken rather than unavailable.
    const onJumpKey = (e: KeyboardEvent): void => {
      host.classList.toggle('cm-jumpArmed', lspReady.current && (e.metaKey || e.ctrlKey))
    }
    const disarm = (): void => host.classList.remove('cm-jumpArmed')
    host.addEventListener('mousedown', onJumpClick)
    host.addEventListener('keydown', onJumpF12)
    window.addEventListener('keydown', onJumpKey)
    window.addEventListener('keyup', onJumpKey)
    window.addEventListener('blur', disarm)

    // Grammar arrives async — swap it into the live view rather than rebuilding.
    let alive = true
    if (!loadedLanguage(fileName, content.language)) {
      void loadLanguage(fileName, content.language).then((support) => {
        if (alive && support) view.dispatch({ effects: language.reconfigure(support) })
      })
    }
    // Same for the language server: connecting spawns a process, so it must not
    // hold up first paint.
    const connectLsp = async (): Promise<boolean> => {
      const ext = await lspExtension(path)
      if (!alive || !ext) return false
      view.dispatch({ effects: lsp.reconfigure(ext) })
      lspReady.current = true
      return true
    }
    void connectLsp()

    return () => {
      alive = false
      lspReady.current = false
      window.clearTimeout(noticeTimer.current)
      if (frame) cancelAnimationFrame(frame)
      setScrollTop(path, view.scrollDOM.scrollTop)
      view.scrollDOM.removeEventListener('scroll', onScroll)
      host.removeEventListener('mousedown', onJumpClick)
      host.removeEventListener('keydown', onJumpF12)
      window.removeEventListener('keydown', onJumpKey)
      window.removeEventListener('keyup', onJumpKey)
      window.removeEventListener('blur', disarm)
      syncBuffer(path, view.state, false)
      unregisterView(path, view)
      view.destroy()
      viewRef.current = null
    }
    // Mount-only: `path` keys the component in RightPanel, so a different file
    // is a different instance. Re-running this on a content change would throw
    // away the user's edits — disk changes come in through `adoptDisk` instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {content.truncated && (
        <div className={cn(editorNotice, 'text-muted-foreground')}>
          Read-only — this file is larger than 2 MB and only its first 2 MB are
          shown. Saving would overwrite the rest.
        </div>
      )}
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden font-mono">
        {(problems.errors > 0 || problems.warnings > 0) && (
          <button
            type="button"
            // Bottom-right, out of the way of the code and of the pill, which
            // is anchored to the selection and so lives up in the text.
            onClick={() => {
              const view = viewRef.current
              if (view) {
                view.focus()
                openLintPanel(view)
              }
            }}
            title="Show problems"
            className="absolute right-3 bottom-3 z-20 flex items-center gap-2 rounded-lg border border-border bg-popover/95 px-2 py-1 text-[11px] text-muted-foreground shadow-md backdrop-blur hover:bg-accent"
          >
            {problems.errors > 0 && (
              <span className="flex items-center gap-1">
                <CircleAlert className="size-3 text-destructive" />
                {problems.errors}
              </span>
            )}
            {problems.warnings > 0 && (
              <span className="flex items-center gap-1">
                <TriangleAlert className="size-3 text-warning" />
                {problems.warnings}
              </span>
            )}
          </button>
        )}
        {notice && (
          <div
            // `pointer-events-none`: it answers a click rather than inviting
            // one, and it lands directly under the pointer — catching the next
            // click would make the explanation eat the retry.
            style={{ top: notice.top, left: notice.left }}
            className="pointer-events-none absolute z-30 max-w-[min(28rem,90%)] rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[11px] text-popover-foreground shadow-md"
          >
            {notice.text}
          </div>
        )}
        {anchor && (
          <button
            type="button"
            // mousedown would collapse the selection before the click resolves.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => addSelectionToChat(path)}
            style={{ top: anchor.top, left: anchor.left, height: PILL_HEIGHT }}
            className="absolute z-20 flex items-center gap-1.5 rounded-lg border border-border bg-popover px-2.5 text-xs whitespace-nowrap text-popover-foreground shadow-md hover:bg-accent"
          >
            <MessageSquarePlus className="size-3.5 text-primary" />
            Add to chat
            <span className="text-[10.5px] text-muted-foreground">
              {anchor.startLine === anchor.endLine
                ? `L${anchor.startLine}`
                : `L${anchor.startLine}-${anchor.endLine}`}
            </span>
            <kbd className="ml-0.5 rounded border border-border/70 px-1 font-mono text-[10px] text-muted-foreground">
              ⌘L
            </kbd>
          </button>
        )}
      </div>
    </div>
  )
})
