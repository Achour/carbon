import * as React from 'react'
import '@xterm/xterm/css/xterm.css'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { RotateCw } from 'lucide-react'
import type { ChatMeta, TerminalEvent } from '@shared/types'
import { PROVIDER_SHORT_LABELS, chatTerminalId } from '@shared/types'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { basename } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * How a tab's shell should spawn. A tab may pin its own folder and a one-shot
 * command (worktree setup); otherwise it follows the active chat's folder, else
 * the selected project.
 */
function spawnFor(id: string): { cwd: string; command?: string; chatId?: string } {
  const s = useApp.getState()
  const tab = s.terminals.find((t) => t.id === id)
  const chat = s.chats.find((c) => c.id === s.activeId)
  return {
    cwd: tab?.cwd ?? chat?.cwd ?? s.selectedCwd ?? '',
    command: tab?.command,
    // The tab's own chat, not the active one — the tab outlives switching away,
    // and deleting the chat it came from is what reaps it.
    chatId: tab?.chatId
  }
}

// Resolve a CSS custom property to a concrete color xterm can parse (hex/rgb),
// going through a canvas so oklch() theme values are normalized.
const canvas = document.createElement('canvas')
const ctx = canvas.getContext('2d')
function cssVarColor(name: string, fallback: string): string {
  const probe = document.createElement('span')
  probe.style.color = `var(${name})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  if (!ctx) return resolved || fallback
  try {
    ctx.fillStyle = '#000'
    ctx.fillStyle = resolved
    return ctx.fillStyle || fallback
  } catch {
    return fallback
  }
}

function themeColors(): ITheme {
  const dark = document.documentElement.classList.contains('dark')
  const ansi = dark
    ? {
        black: '#3b3b3b',
        red: '#e06c75',
        green: '#98c379',
        yellow: '#e5c07b',
        blue: '#61afef',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#d7dae0',
        brightBlack: '#6b6b6b',
        brightRed: '#e06c75',
        brightGreen: '#98c379',
        brightYellow: '#e5c07b',
        brightBlue: '#61afef',
        brightMagenta: '#c678dd',
        brightCyan: '#56b6c2',
        brightWhite: '#ffffff'
      }
    : {
        black: '#24292f',
        red: '#cf222e',
        green: '#116329',
        yellow: '#7d4e00',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#1b7c83',
        white: '#57606a',
        brightBlack: '#6e7781',
        brightRed: '#a40e26',
        brightGreen: '#1a7f37',
        brightYellow: '#9a6700',
        brightBlue: '#0550ae',
        brightMagenta: '#6639ba',
        brightCyan: '#0a6870',
        brightWhite: '#24292f'
      }
  return {
    background: cssVarColor('--code-bg', '#1c1c1c'),
    foreground: cssVarColor('--foreground', '#e4e4e4'),
    cursor: cssVarColor('--primary', '#e4e4e4'),
    cursorAccent: cssVarColor('--code-bg', '#1c1c1c'),
    selectionBackground: cssVarColor('--accent', '#3a3a3a'),
    ...ansi
  }
}

function codeFontSize(): number {
  const px = parseInt(
    getComputedStyle(document.documentElement).getPropertyValue('--code-font-size')
  )
  return Number.isFinite(px) && px >= 8 ? px : 12
}

/**
 * How a pane brings its process up and keeps it there. Two implementations: a
 * tab's login shell, which is created and killed with its pane, and a **terminal
 * chat**'s CLI, which outlives every pane it is ever drawn in.
 */
interface PaneSpawn {
  /** Start or resume the process. Resolves to a message to draw, or null. */
  start: (cols: number, rows: number) => Promise<string | null>
  /** Throw the process away and start over. */
  restart: (cols: number, rows: number) => Promise<string | null>
  /**
   * Survive this pane's unmount. The process keeps running with nothing
   * watching, recording what it writes, and the next mount reattaches and
   * replays it — which is what lets a terminal chat be left and come back to.
   */
  persist?: boolean
}

/**
 * The xterm half, shared by both surfaces: the grid, the theme, the keystroke
 * and resize plumbing, and the exit line. Everything that differs between a tab
 * and a terminal chat is in `spawn` and `label` — one lifecycle, so the two
 * cannot drift.
 *
 * `id` is the pty session id; `active` tells the pane when it is the visible one
 * so it can refit, focus and flush what it buffered while hidden.
 */
function Pane({
  id,
  active,
  spawn,
  label,
  restartLabel
}: {
  id: string
  active: boolean
  spawn: PaneSpawn
  label: React.ReactNode
  restartLabel: string
}): React.JSX.Element {
  const [error, setError] = React.useState<string | null>(null)

  const containerRef = React.useRef<HTMLDivElement>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  const exitedRef = React.useRef(false)
  const activeRef = React.useRef(active)
  const pendingOutputRef = React.useRef('')
  // Timestamp of the last spawn, so an exit that lands right after one (a
  // replacement, or React StrictMode's dev remount) doesn't print a stale
  // "process exited" line — only a genuine, later exit does.
  const lastSpawnRef = React.useRef(0)
  // Read through a ref so changing the strategy cannot tear down the terminal:
  // the effect below owns an xterm instance and a live process, and re-running
  // it would throw both away.
  const spawnRef = React.useRef(spawn)
  spawnRef.current = spawn
  // True from the moment a bring starts until its output has been written.
  // Everything the pty emits meanwhile is buffered: a reattach's replay is
  // fetched across an await, and a byte written live in that gap would land
  // *above* the history it belongs after.
  const bringingRef = React.useRef(true)

  /** Write what arrived while the pane was hidden, or mid-bring. */
  const flushPending = React.useCallback((): void => {
    const pending = pendingOutputRef.current
    pendingOutputRef.current = ''
    if (pending) termRef.current?.write(pending)
  }, [])

  /**
   * Put the pane in front of a running process: reattach to one that outlived
   * an earlier pane, or start one.
   */
  const bring = React.useCallback(
    async (mode: 'mount' | 'restart'): Promise<void> => {
      const term = termRef.current
      if (!term) return
      lastSpawnRef.current = performance.now()
      exitedRef.current = false
      bringingRef.current = true
      setError(null)
      try {
        if (spawnRef.current.persist && mode === 'mount') {
          const attached = await window.api.terminalAttach(id, term.cols, term.rows)
          // The pane unmounted while we were asking.
          if (termRef.current !== term) return
          if (attached.alive) {
            // The replay is the whole account of the session, so the grid is
            // cleared first — a remount must not print it under the last one.
            term.reset()
            if (attached.data) term.write(attached.data)
            return
          }
        }
        const run = mode === 'mount' ? spawnRef.current.start : spawnRef.current.restart
        const message = await run(term.cols, term.rows)
        if (termRef.current !== term) return
        if (message) setError(message)
      } finally {
        bringingRef.current = false
        if (termRef.current === term && activeRef.current) flushPending()
      }
    },
    [id, flushPending]
  )

  const restart = React.useCallback((): void => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.reset()
    fit.fit()
    void bring('restart')
    term.focus()
  }, [bring])

  // One-time init: create the terminal + process when the pane first mounts.
  React.useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: codeFontSize(),
      lineHeight: 1.2,
      cursorBlink: activeRef.current,
      allowProposedApi: false,
      theme: themeColors()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit
    fit.fit()

    // Keystrokes → pty (unless the process exited, in which case any key restarts).
    const dataSub = term.onData((data) => {
      if (exitedRef.current) {
        restart()
        return
      }
      void window.api.terminalWrite(id, data)
    })

    // pty output / exit → terminal.
    const offEvent = window.api.onTerminalEvent((ev: TerminalEvent) => {
      if (ev.id !== id) return
      const write = (data: string): void => {
        if (activeRef.current && !bringingRef.current) {
          term.write(data)
          return
        }
        // Keep the pty alive without asking xterm/Chromium to render every
        // background byte. Bound the buffer to prevent runaway memory use.
        const next = pendingOutputRef.current + data
        pendingOutputRef.current = next.length > 1_000_000 ? next.slice(-1_000_000) : next
      }
      if (ev.type === 'data') {
        write(ev.data)
      } else if (ev.type === 'exit') {
        // Ignore an exit right after a spawn (session replacement / StrictMode
        // dev remount) — the fresh process is already taking over.
        if (performance.now() - lastSpawnRef.current < 600) return
        exitedRef.current = true
        write(
          `\r\n\x1b[90m[process exited (${ev.exitCode}) — press any key to restart]\x1b[0m\r\n`
        )
      }
      // `busy` and `activity` are handled globally in App: both have to keep
      // reporting for a session whose pane is hidden or unmounted, which is the
      // case each of them exists for.
    })

    // Keep the pty's grid in sync with the rendered size.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // container detached or zero-sized mid-measure
      }
      void window.api.terminalResize(id, term.cols, term.rows)
    })
    ro.observe(containerRef.current)

    // Re-theme live when the app theme changes.
    const mo = new MutationObserver(() => {
      term.options.theme = themeColors()
      term.options.fontSize = codeFontSize()
    })
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-appearance']
    })

    void bring('mount')
    term.focus()

    return () => {
      dataSub.dispose()
      offEvent()
      ro.disconnect()
      mo.disconnect()
      // A persistent session is left running and told to stop streaming to a
      // pane that is gone; the next mount reattaches and replays it. Killing it
      // here is what a tab wants and what a terminal chat must never do — a
      // chat switch would end the conversation.
      if (spawnRef.current.persist) void window.api.terminalDetach(id)
      else void window.api.terminalKill(id)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [id, bring, restart])

  // Refit + focus whenever the terminal becomes the visible pane.
  React.useEffect(() => {
    activeRef.current = active
    const term = termRef.current
    if (term) term.options.cursorBlink = active
    if (!active) return
    const raf = requestAnimationFrame(() => {
      if (!bringingRef.current) flushPending()
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
      const visibleTerm = termRef.current
      if (visibleTerm) {
        void window.api.terminalResize(id, visibleTerm.cols, visibleTerm.rows)
        visibleTerm.focus()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [active, id, flushPending])

  return (
    <div className="flex h-full flex-col bg-[var(--code-bg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 pr-1.5 pl-3">
        {label}
        <WithTooltip label={restartLabel}>
          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-auto shrink-0"
            onClick={restart}
            aria-label="Restart terminal"
          >
            <RotateCw />
          </Button>
        </WithTooltip>
      </div>
      {/* The error replaces the grid rather than sitting above it: there is no
          process, so there is nothing for a terminal to show. */}
      <div className={cn('relative min-h-0 flex-1 px-2 pt-1', error && 'invisible')}>
        <div ref={containerRef} className="h-full" />
      </div>
      {error && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <p className="max-w-[52ch] text-center text-xs whitespace-pre-wrap text-muted-foreground">
            {error}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * One terminal, rendered as a right-panel tab body. `id` is both the tab id and
 * the pty session id. Mounted while its tab exists (kept alive across tab
 * switches so scrollback survives); `active` tells it when it's the visible tab
 * so it can refit and focus.
 */
export function TerminalPane({ id, active }: { id: string; active: boolean }): React.JSX.Element {
  const [spawnCwd, setSpawnCwd] = React.useState('')

  const start = React.useCallback(
    async (cols: number, rows: number): Promise<string | null> => {
      const { cwd, command, chatId } = spawnFor(id)
      setSpawnCwd(cwd)
      await window.api.terminalCreate({ id, cwd, cols, rows, command, chatId })
      return null
    },
    [id]
  )
  const spawn = React.useMemo<PaneSpawn>(() => ({ start, restart: start }), [start])

  return (
    <Pane
      id={id}
      active={active}
      spawn={spawn}
      restartLabel="Restart in current folder"
      label={
        spawnCwd ? (
          <WithTooltip label={spawnCwd}>
            <span className="truncate text-[11px] text-muted-foreground/80">
              {basename(spawnCwd)}
            </span>
          </WithTooltip>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">shell</span>
        )
      }
    />
  )
}

/**
 * A **terminal chat**: your login shell, in the column where a transcript would
 * be. `ChatView` draws this instead of its messages and composer; the header,
 * the right panel and the sidebar row around it are the same ones every chat
 * gets.
 *
 * Main owns everything past "there is a shell": noticing which CLI session you
 * start in it, and typing the resume command when the chat is reopened
 * (`main/chatTerminal.ts`). All this component knows is that a process lives
 * under `chatTerminalId(chat.id)` and has to still be there when the pane comes
 * back.
 */
export function ChatTerminal({ chat }: { chat: ChatMeta }): React.JSX.Element {
  const id = chatTerminalId(chat.id)

  const spawn = React.useMemo<PaneSpawn>(() => {
    const call = async (
      run: Promise<{ id: string } | { error: string }>
    ): Promise<string | null> => {
      const result = await run
      return 'error' in result ? result.error : null
    }
    return {
      persist: true,
      start: (cols, rows) => call(window.api.chatTerminalStart(chat.id, cols, rows)),
      restart: (cols, rows) => call(window.api.chatTerminalRestart(chat.id, cols, rows))
    }
  }, [chat.id])

  // The provider is only a fact once a session has been identified in the pane;
  // before that the chat's `provider` is a placeholder nobody chose.
  const running = chat.sessionId ? PROVIDER_SHORT_LABELS[chat.provider] : null
  return (
    <Pane
      id={id}
      active
      spawn={spawn}
      restartLabel={running ? `Restart, resuming this ${running} session` : 'Restart terminal'}
      label={
        <WithTooltip label={chat.cwd}>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/80">
            {running && (
              <>
                <span className="shrink-0">{running}</span>
                <span className="text-border">/</span>
              </>
            )}
            <span className="truncate">{basename(chat.cwd)}</span>
          </span>
        </WithTooltip>
      }
    />
  )
}
