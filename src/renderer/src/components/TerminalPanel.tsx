import * as React from 'react'
import '@xterm/xterm/css/xterm.css'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { RotateCw } from 'lucide-react'
import type { TerminalEvent } from '@shared/types'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'
import { basename } from '@/lib/format'

/** cwd for a new shell: the active chat's folder, else the selected project. */
function currentCwd(): string {
  const s = useApp.getState()
  const chat = s.chats.find((c) => c.id === s.activeId)
  return chat?.cwd ?? s.selectedCwd ?? ''
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
  return {
    background: cssVarColor('--code-bg', '#1c1c1c'),
    foreground: cssVarColor('--foreground', '#e4e4e4'),
    cursor: cssVarColor('--primary', '#e4e4e4'),
    cursorAccent: cssVarColor('--code-bg', '#1c1c1c'),
    selectionBackground: cssVarColor('--accent', '#3a3a3a'),
    // A neutral-friendly ANSI palette (One Dark-ish) that reads on dark backgrounds.
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
}

function codeFontSize(): number {
  const px = parseInt(
    getComputedStyle(document.documentElement).getPropertyValue('--code-font-size')
  )
  return Number.isFinite(px) && px >= 8 ? px : 12
}

/**
 * One terminal, rendered as a right-panel tab body. `id` is both the tab id and
 * the pty session id. Mounted while its tab exists (kept alive across tab
 * switches so scrollback survives); `active` tells it when it's the visible tab
 * so it can refit and focus.
 */
export function TerminalPane({ id, active }: { id: string; active: boolean }): React.JSX.Element {
  const [spawnCwd, setSpawnCwd] = React.useState('')

  const containerRef = React.useRef<HTMLDivElement>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  const exitedRef = React.useRef(false)
  // Timestamp of the last spawn, so an exit that lands right after one (a
  // replacement, or React StrictMode's dev remount) doesn't print a stale
  // "process exited" line — only a genuine, later exit does.
  const lastSpawnRef = React.useRef(0)

  const spawn = React.useCallback((): void => {
    const term = termRef.current
    if (!term) return
    const cwd = currentCwd()
    setSpawnCwd(cwd)
    lastSpawnRef.current = performance.now()
    exitedRef.current = false
    void window.api.terminalCreate({ id, cwd, cols: term.cols, rows: term.rows })
  }, [id])

  const restart = React.useCallback((): void => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.reset()
    fit.fit()
    spawn()
    term.focus()
  }, [spawn])

  // One-time init: create the terminal + shell when the tab first mounts.
  React.useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: codeFontSize(),
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: false,
      theme: themeColors()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit
    fit.fit()

    // Keystrokes → pty (unless the shell exited, in which case any key restarts).
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
      if (ev.type === 'data') {
        term.write(ev.data)
      } else {
        // Ignore an exit right after a spawn (session replacement / StrictMode
        // dev remount) — the fresh shell is already taking over.
        if (performance.now() - lastSpawnRef.current < 600) return
        exitedRef.current = true
        term.write(
          `\r\n\x1b[90m[process exited (${ev.exitCode}) — press any key to restart]\x1b[0m\r\n`
        )
      }
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
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    spawn()
    term.focus()

    return () => {
      dataSub.dispose()
      offEvent()
      ro.disconnect()
      mo.disconnect()
      void window.api.terminalKill(id)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [spawn, restart])

  // Refit + focus whenever the terminal becomes the visible tab.
  React.useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
      const term = termRef.current
      if (term) {
        void window.api.terminalResize(id, term.cols, term.rows)
        term.focus()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [active, id])

  return (
    <div className="flex h-full flex-col bg-[var(--code-bg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 pr-1.5 pl-3">
        {spawnCwd ? (
          <WithTooltip label={spawnCwd}>
            <span className="truncate text-[11px] text-muted-foreground/80">
              {basename(spawnCwd)}
            </span>
          </WithTooltip>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">shell</span>
        )}
        <WithTooltip label="Restart in current folder">
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
      <div ref={containerRef} className="min-h-0 flex-1 px-2 pt-1" />
    </div>
  )
}
