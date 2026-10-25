import * as React from 'react'
import { create } from 'zustand'
import {
  PROVIDER_LABELS,
  PROVIDER_SHORT_LABELS,
  PROVIDERS,
  modelDisplayName,
  projectRoot,
  type PermissionModeId,
  type ProviderUsage
} from '@shared/types'
import { PATHS, PROVIDER_COLOR } from '@/components/ui/provider-mark'
import { USAGE_CRITICAL, USAGE_WARN, peakUtilization } from '@/components/UsageBar'
import { shortenPath } from '@/lib/format'
import { chatActivityKind } from '@/lib/chatActivity'
import { assembleModelOptions, modelKey } from '@/lib/models'
import { useApp } from '@/store'
import { useRemote } from './state'
import { CHATS_PER_PROJECT_MAX, CHATS_PER_PROJECT_MIN, CODE_MAX, CODE_MIN, TEXT_SIZES, usePrefs } from './prefs'
import { THEMES } from '@/lib/themes'
import { baseName, chatTitle, listedChats, sidebarSections } from './format'
import { groupByProvider, type OptionValues, type Pickers } from './options'
import { placeChat, rename, setArchived, setPinned } from './chatActions'
import { changes, diff, invoke, markSeen } from './api'
import { deriveBoard } from './board'
import { greeting } from '@/lib/format'
import { promptLine } from '@shared/promptLine'
import { nativeRequest, questionDecision } from './PermissionCard'
import type { BranchRef, Canvas, PermissionDecision, WorktreeRef, WorktreeTarget } from '@shared/types'

/**
 * The Carbon iOS app's half of the page (`docs/remote.md`, "Inside the iOS
 * app"). The app holds this client in one WKWebView and draws the parts a web
 * page draws worst — the drawer and its gesture, the header, the composer on
 * the keyboard, the pickers' sheets — natively, over the page. Everything else
 * stays here: the store, the resync, the queue, the drafts, the transcript.
 *
 * So the page is the model and the app is a view of it. The page posts what
 * the app draws (`publish`), and the app calls back into `window.carbonNative`
 * for what a tap does. Nothing the app shows is computed twice.
 */

interface MessageHandler {
  postMessage(message: unknown): void
}

const handler = (window as unknown as { webkit?: { messageHandlers?: { carbon?: MessageHandler } } }).webkit
  ?.messageHandlers?.carbon

/** True inside the iOS app. Read once: the handler is injected before any script runs. */
export const isNative = !!handler

/**
 * A moment the app reacts to that is not state: `drag` (put the keyboard
 * away), `open` (push a native screen: a diff, a canvas, a plan).
 */
export function notifyApp(type: string, detail?: Record<string, unknown>): void {
  handler?.postMessage({ type, ...detail })
}

/** The composer a screen would have drawn, as the app draws it. */
export interface NativeComposer {
  /** The draft it belongs to; the app starts a fresh field when this changes. */
  key: string
  chatId?: string
  placeholder: string
  text: string
  /** Bumped when the page itself changes the text (a pick, a send), never by typing. */
  textRev: number
  /** Where the page puts the caret with such a change (after a picked `@` file). */
  caret: number
  busy: boolean
  /** Empty while a turn runs: the send button is Stop. */
  stop: boolean
  sending: boolean
  /** Files still being read in. */
  reading: number
  attachments: { id: string; name: string; kind: string }[]
  queued: { id: string; text: string }[]
  suggestion?: string
  menu?: { kind: 'files' | 'commands'; rows: { id: string; label: string; detail?: string }[] }
}

export interface NativeComposerActions {
  setText(text: string, caret: number): void
  submit(): void
  stop(): void
  pick(id: string): void
  dismissMenu(): void
  removeAttachment(id: string): void
  addFiles(files: File[]): void
  takeSuggestion(): void
}

interface NativeUi {
  /** What the app shows: nothing of its own until the page is paired and running. */
  phase: 'loading' | 'pairing' | 'app'
  composer: NativeComposer | null
  composerActions: NativeComposerActions | null
  pickers: { values: OptionValues; p: Pickers; onChange: (patch: Partial<OptionValues>, remember: boolean) => void } | null
  /** Sheets and the lightbox open on the page; the app gets out of their way. */
  overlays: number
  /**
   * Full-screen layers the page draws under the app's navigation bar (a
   * sub-agent's transcript), topmost last; the app draws the bar and its Back.
   */
  viewers: { id: number; title: string; close: () => void }[]
  /** The New-chat screen's project, and the projects it offers. */
  newChat: { cwd: string; projects: string[]; pick: (root: string) => void } | null
  /** Where the next chat runs (`WorktreeChip`): only for a repository. */
  place: {
    cwd: string
    value: WorktreeTarget
    refs: WorktreeRef[]
    onChange: (target: WorktreeTarget) => void
    reload: () => void
  } | null
}

export const useNative = create<NativeUi>(() => ({
  phase: 'loading',
  composer: null,
  composerActions: null,
  pickers: null,
  overlays: 0,
  viewers: [],
  newChat: null,
  place: null
}))

/** A registration that lasts while its screen is up, cleared only by its own owner. */
function useSlot<K extends 'newChat' | 'place'>(key: K, value: NativeUi[K], deps: React.DependencyList): void {
  const owner = React.useRef<NativeUi[K]>(null)
  React.useEffect(() => {
    if (!isNative) return
    owner.current = value
    useNative.setState({ [key]: value } as Partial<NativeUi>)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  React.useEffect(
    () => () => {
      if (isNative && useNative.getState()[key] === owner.current) useNative.setState({ [key]: null } as Partial<NativeUi>)
    },
    [key]
  )
}

/** The New-chat screen's project picker, drawn by the app. */
export function useNativeNewChat(cwd: string | null, projects: string[], pick: (root: string) => void): void {
  const latest = React.useRef(pick)
  latest.current = pick
  useSlot('newChat', cwd ? { cwd, projects, pick: (root) => latest.current(root) } : null, [cwd, projects.join('\n')])
}

/** Where the next chat runs, drawn by the app; `refs` empty means not a repository. */
export function useNativePlace(
  cwd: string,
  value: WorktreeTarget,
  refs: WorktreeRef[] | null,
  onChange: (target: WorktreeTarget) => void,
  reload: () => void
): void {
  const change = React.useRef(onChange)
  change.current = onChange
  const again = React.useRef(reload)
  again.current = reload
  useSlot(
    'place',
    refs?.length ? { cwd, value, refs, onChange: (t) => change.current(t), reload: () => again.current() } : null,
    [cwd, JSON.stringify(value), JSON.stringify(refs)]
  )
}

let viewerIds = 0

/** A full-screen layer whose bar the app draws: its title, and what Back does. */
export function useNativeViewer(title: string, close: () => void): void {
  const id = React.useMemo(() => ++viewerIds, [])
  const latest = React.useRef(close)
  latest.current = close
  React.useEffect(() => {
    if (!isNative) return undefined
    const entry = { id, title, close: () => latest.current() }
    useNative.setState((s) => {
      const at = s.viewers.findIndex((v) => v.id === id)
      return { viewers: at === -1 ? [...s.viewers, entry] : s.viewers.map((v) => (v.id === id ? entry : v)) }
    })
  }, [id, title])
  React.useEffect(
    () => () => {
      if (isNative) useNative.setState((s) => ({ viewers: s.viewers.filter((v) => v.id !== id) }))
    },
    [id]
  )
}

/**
 * Hand this screen's composer to the app. The text is the app's while the
 * user types; a change the page makes itself (a picked `@` file, a send
 * clearing it, a suggestion taken) bumps `textRev`, and that is the app's cue
 * to take the page's text over its own. The composer counts those changes
 * itself: telling them apart by comparing texts misread a render that lagged
 * fast typing as the page's own change, and the app threw keystrokes away.
 */
export function useNativeComposer(spec: NativeComposer, actions: NativeComposerActions): void {
  const latest = React.useRef(actions)
  latest.current = actions
  const stable = React.useMemo<NativeComposerActions>(
    () => ({
      setText: (text, caret) => latest.current.setText(text, caret),
      submit: () => latest.current.submit(),
      stop: () => latest.current.stop(),
      pick: (id) => latest.current.pick(id),
      dismissMenu: () => latest.current.dismissMenu(),
      removeAttachment: (id) => latest.current.removeAttachment(id),
      addFiles: (files) => latest.current.addFiles(files),
      takeSuggestion: () => latest.current.takeSuggestion()
    }),
    []
  )
  React.useEffect(() => {
    if (isNative) useNative.setState({ composer: spec, composerActions: stable })
  })
  React.useEffect(
    () => () => {
      if (isNative && useNative.getState().composerActions === stable) {
        useNative.setState({ composer: null, composerActions: null })
      }
    },
    [stable]
  )
}

/** Hand this screen's pickers to the app, which draws the chips and their sheets. */
export function useNativePickers(
  values: OptionValues,
  p: Pickers,
  onChange: (patch: Partial<OptionValues>, remember: boolean) => void
): void {
  const latest = React.useRef(onChange)
  latest.current = onChange
  const change = React.useCallback(
    (patch: Partial<OptionValues>, remember: boolean) => latest.current(patch, remember),
    []
  )
  // `p` is recomputed exactly when the values it was computed from change.
  React.useEffect(() => {
    if (isNative) useNative.setState({ pickers: { values, p, onChange: change } })
  }, [p, change])
  React.useEffect(
    () => () => {
      if (isNative && useNative.getState().pickers?.onChange === change) useNative.setState({ pickers: null })
    },
    [change]
  )
}

/** While `open`, the page is showing a layer the app's chrome would cover. */
export function useNativeOverlay(open: boolean): void {
  React.useEffect(() => {
    if (!isNative || !open) return undefined
    useNative.setState((s) => ({ overlays: s.overlays + 1 }))
    return () => useNative.setState((s) => ({ overlays: s.overlays - 1 }))
  }, [open])
}

/** A command the app sends to whatever screen is up (`scrollTop`, `viewChanges`). */
export function useNativeCommand(name: string, run: () => void): void {
  const latest = React.useRef(run)
  latest.current = run
  React.useEffect(() => {
    if (!isNative) return undefined
    const on = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === name) latest.current()
    }
    window.addEventListener('carbon-native', on)
    return () => window.removeEventListener('carbon-native', on)
  }, [name])
}

const SHORT_MODE: Partial<Record<PermissionModeId, string>> = {
  default: 'Ask',
  acceptEdits: 'Edits',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Full'
}

function pickerState(pickers: NonNullable<NativeUi['pickers']>): unknown {
  const { values, p } = pickers
  return {
    modelLabel: p.modelLabel,
    effortLabel: p.efforts.length > 1 ? p.efforts.find((e) => e.id === p.effort)?.label : undefined,
    fast: p.serviceTier === 'fast',
    effort: p.effort,
    efforts: p.efforts.map((e) => ({ id: e.id, label: e.label })),
    serviceTier: p.serviceTier,
    tiers: p.tiers.map((t) => ({ id: t.id, label: t.label })),
    permissionMode: p.permissionMode,
    modeLabel: SHORT_MODE[p.permissionMode] ?? 'Ask',
    modes: p.modes.map((m) => ({ id: m.id, label: m.label, description: m.description })),
    models: groupByProvider(p.models).map((g) => ({
      provider: g.provider,
      label: g.label,
      color: cssHex(PROVIDER_COLOR[g.provider]),
      rows: g.rows.map((m) => ({
        key: modelKey(m.provider, m.id),
        label: m.label,
        description: m.description ?? m.resolvedModel ?? '',
        selected: m.provider === values.provider && m.id === p.selectedModel
      }))
    }))
  }
}

const PLACE_LABEL: Record<WorktreeTarget['kind'], string> = {
  local: 'This Mac',
  new: 'New worktree',
  branch: 'New worktree',
  existing: 'Worktree'
}

function placeState(place: NonNullable<NativeUi['place']>, home: string): unknown {
  const { value, refs } = place
  const short = (p: string): string => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)
  const branch = value.kind === 'existing' || value.kind === 'branch' ? value.branch : value.kind === 'new' ? value.branch : undefined
  return {
    cwd: place.cwd,
    label: PLACE_LABEL[value.kind],
    branch: branch ?? null,
    kind: value.kind,
    path: value.kind === 'existing' ? value.path : null,
    repoRoot: refs.find((r) => r.isMain)?.path ?? place.cwd,
    worktrees: refs
      .filter((r) => !r.isMain)
      .map((r) => ({ path: r.path, branch: r.branch, merged: !!r.merged, short: short(r.path) }))
  }
}

/**
 * Images the app can decode. UIKit reads PNG and JPEG but not SVG, and a
 * project's mark is often an SVG (a favicon, an app icon), as every provider
 * mark is: those are drawn to a canvas here, once each, and posted as PNG.
 * Until one is ready it reads as missing, which draws initials.
 */
const rasters = new Map<string, string | null>()

function raster(uri: string): string | null {
  if (!uri.startsWith('data:image/svg')) return uri
  const done = rasters.get(uri)
  if (done !== undefined) return done
  rasters.set(uri, null)
  const img = new Image()
  img.onload = () => {
    const size = 96
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size })
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = img.naturalWidth || size
    const h = img.naturalHeight || size
    const scale = Math.min(size / w, size / h)
    ctx.drawImage(img, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale)
    rasters.set(uri, canvas.toDataURL('image/png'))
    publish()
  }
  img.src = uri
  return null
}

let marks: Record<string, string | null> | null = null

/**
 * Each provider's mark in its own colour, as the app draws it beside a row.
 * Built once per theme (`publishTheme` drops it), not once per post: a post
 * goes out every frame a reply streams.
 */
function providerMarks(): Record<string, string | null> {
  if (marks && Object.values(marks).every(Boolean)) return marks
  const out: Record<string, string | null> = {}
  for (const p of PROVIDERS) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96" fill="${cssHex(PROVIDER_COLOR[p])}">${PATHS[p].map((d) => `<path d="${d}"/>`).join('')}</svg>`
    out[p] = raster(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  }
  marks = out
  return out
}

const tone = (pct: number | null | undefined): 'normal' | 'warn' | 'critical' =>
  pct == null ? 'normal' : pct >= USAGE_CRITICAL ? 'critical' : pct >= USAGE_WARN ? 'warn' : 'normal'

/** The plan's headroom, as the web app's Usage sheet shows it. */
function usageState(usage: { claude: ProviderUsage; codex: ProviderUsage } | null): unknown {
  if (!usage) return null
  const peak = peakUtilization(usage)
  return {
    peak: peak
      ? { label: `${PROVIDER_SHORT_LABELS[peak.provider]} ${Math.round(peak.pct)}%`, pct: peak.pct, tone: tone(peak.pct) }
      : null,
    providers: [usage.claude, usage.codex].map((p) => ({
      provider: p.provider,
      name: PROVIDER_SHORT_LABELS[p.provider],
      plan: p.plan ?? null,
      available: p.available,
      note: p.note ?? null,
      resetCredits: p.resetCredits ?? 0,
      windows: p.windows.map((w) => ({
        label: w.label,
        pct: w.utilization,
        tone: tone(w.utilization),
        resetsAt: w.resetsAt ? Date.parse(w.resetsAt) || null : null
      }))
    }))
  }
}

let probe: CanvasRenderingContext2D | null = null

/**
 * A colour as the app can use it, `#rrggbb`: a `var(--token)` is read off the
 * root first, since a canvas cannot resolve one.
 */
function cssHex(cssColor: string): string {
  probe ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', {
    willReadFrequently: true
  })
  const name = /^var\((--[\w-]+)\)$/.exec(cssColor.trim())?.[1]
  const value = name ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : cssColor
  return probe && value ? hex(value, probe) : '#888888'
}

/** A colour as the app can use it: whatever CSS says, resolved to `#rrggbb` by a canvas. */
function hex(cssColor: string, ctx: CanvasRenderingContext2D): string {
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = '#000'
  ctx.fillStyle = cssColor
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

const THEME_TOKENS = [
  'background',
  'foreground',
  'muted',
  'muted-foreground',
  'card',
  'border',
  'primary',
  'primary-foreground',
  'accent',
  'sidebar',
  'sidebar-foreground',
  'sidebar-accent',
  'popover',
  'warning',
  'destructive'
]

function theme(): Record<string, string | boolean> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const out: Record<string, string | boolean> = {
    dark: document.documentElement.classList.contains('dark'),
    // Only an explicit Light or Dark is the app's to wear: in System the app
    // follows the phone, and the page follows the app. Wearing the page's
    // resolved appearance there would pin both to whichever came first.
    mode: usePrefs.getState().themeMode
  }
  if (!ctx) return out
  const style = getComputedStyle(document.documentElement)
  for (const token of THEME_TOKENS) {
    const value = style.getPropertyValue(`--${token}`).trim()
    if (value) out[token] = hex(value, ctx)
  }
  return out
}

function route(): { name: string; id?: string; cwd?: string } {
  const h = location.hash
  const chat = /^#\/c\/(.+)$/.exec(h)
  if (chat) return { name: 'chat', id: decodeURIComponent(chat[1]) }
  const fresh = /^#\/new\/([^?]+)/.exec(h)
  if (fresh) return { name: 'new', cwd: decodeURIComponent(fresh[1]) }
  if (h === '#/usage') return { name: 'usage' }
  return { name: 'new' }
}

/** Every slice the app draws, each posted only when it changed. */
function snapshot(): Record<string, unknown> {
  const r = useRemote.getState()
  const n = useNative.getState()
  const at = route()
  const row = (c: (typeof r.chats)[number]): unknown => {
    const kind = chatActivityKind(r.statuses[c.id], undefined, r.permissions[c.id])
    const mark = r.unseen[c.id]
    return {
      id: c.id,
      title: chatTitle(c),
      project: baseName(projectRoot(c)),
      root: projectRoot(c),
      // The detailed row's third line: where the work happens.
      branch: c.worktree?.branch ?? r.branches[c.cwd] ?? null,
      folder: shortenPath(c.cwd, r.home || undefined),
      provider: c.provider,
      activity: kind,
      unseen: mark ? (mark.failed ? 'failed' : 'done') : null,
      pinned: c.pinnedAt !== undefined,
      updatedAt: c.updatedAt
    }
  }
  const prefs = usePrefs.getState()
  // A saved filter naming a project with no chats left reads as no filter (`useProjectFilter`).
  const listed = listedChats(r.chats)
  const filter = prefs.sidebarProject && listed.some((c) => projectRoot(c) === prefs.sidebarProject) ? prefs.sidebarProject : null
  const { waiting, pinned, groups, flat } = sidebarSections(r.chats, r.permissions, '', filter)
  const detailed = prefs.sidebarDensity === 'detailed'
  const counts = new Map<string, { count: number; latest: number }>()
  for (const c of listed) {
    const p = counts.get(projectRoot(c)) ?? { count: 0, latest: 0 }
    p.count++
    p.latest = Math.max(p.latest, c.updatedAt)
    counts.set(projectRoot(c), p)
  }
  const chat = at.name === 'chat' ? r.chats.find((c) => c.id === at.id) : undefined
  const projects: string[] = []
  for (const dir of r.defaults?.recentDirs ?? []) if (!projects.includes(dir)) projects.push(dir)
  for (const c of listedChats(r.chats)) if (!projects.includes(projectRoot(c))) projects.push(projectRoot(c))
  return {
    phase: n.phase,
    connection: r.connection,
    hostname: r.hostname,
    route: at,
    error: r.error,
    overlay: n.overlays > 0 || useApp.getState().lightbox !== null,
    waiting: waiting.length > 0,
    sidebar: {
      density: prefs.sidebarDensity,
      chatsPerProject: prefs.chatsPerProject,
      filter,
      filters: [...counts.entries()]
        .sort((a, b) => b[1].latest - a[1].latest)
        .map(([root, p]) => ({ root, name: baseName(root), count: p.count })),
      waiting: waiting.map(row),
      pinned: pinned.map(row),
      // Detailed rows and a filtered list are one flat list in the user's order;
      // compact rows hang under their project.
      flat: detailed || filter ? flat.map(row) : [],
      groups: detailed || filter ? [] : groups.map(([root, g]) => ({ root, name: baseName(root), chats: g.chats.map(row) }))
    },
    projects: projects.map((root) => ({ root, name: baseName(root) })),
    icons: Object.fromEntries(Object.entries(r.icons).map(([root, uri]) => [root, uri ? raster(uri) : null])),
    providerMarks: providerMarks(),
    usage: usageState(r.usage),
    chat: chat
      ? {
          id: chat.id,
          title: chatTitle(chat),
          subtitle: `${baseName(projectRoot(chat))}${chat.worktree ? ` · ${chat.worktree.branch}` : ''}`,
          provider: PROVIDER_LABELS[chat.provider],
          pinned: chat.pinnedAt !== undefined,
          // A cross-provider pick is armed, not applied: the app says so, with Undo.
          pendingSwitch:
            chat.pendingModel !== undefined && chat.pendingProvider
              ? {
                  model: modelDisplayName(
                    chat.pendingModel,
                    chat.pendingProvider,
                    assembleModelOptions(r.models, r.codexConfigModel, r.available)
                  ),
                  provider: PROVIDER_LABELS[chat.pendingProvider]
                }
              : null
        }
      : null,
    // This phone's display settings, which the app's Settings sheet sets.
    prefs: (() => {
      const p = usePrefs.getState()
      return {
        themeMode: p.themeMode,
        themeId: p.themeId,
        themes: THEMES.map((t) => ({ id: t.id, name: t.name })),
        textSize: p.textSize,
        textSizes: TEXT_SIZES.map((z) => Math.round(z * 100)),
        codeSize: p.codeSize,
        codeMin: CODE_MIN,
        codeMax: CODE_MAX,
        sidebarDensity: p.sidebarDensity,
        chatsPerProject: p.chatsPerProject,
        chatsPerProjectMin: CHATS_PER_PROJECT_MIN,
        chatsPerProjectMax: CHATS_PER_PROJECT_MAX
      }
    })(),
    // The home screen: what needs you, what is working, what finished unseen
    // (`board.ts`, the board the web app's home screen draws).
    board: (() => {
      const b = deriveBoard(r.chats, r.statuses, r.permissions, r.unseen)
      const base = (c: (typeof r.chats)[number]) => ({ chatId: c.id, title: chatTitle(c), project: baseName(projectRoot(c)) })
      return {
        greeting: greeting(),
        needs: b.needs.map((c) => {
          const first = r.permissions[c.id]?.[0]
          return {
            ...base(c),
            line: first ? promptLine(first) : 'Needs your input',
            at: c.updatedAt,
            request: first ? nativeRequest(first, c.provider) : null,
            more: Math.max(0, (r.permissions[c.id]?.length ?? 0) - 1)
          }
        }),
        working: b.working.map((c) => base(c)),
        done: b.done.map(({ chat, mark }) => ({ ...base(chat), line: mark.text ?? '', failed: !!mark.failed, at: mark.at }))
      }
    })(),
    composer: n.composer,
    pickers: n.pickers ? pickerState(n.pickers) : null,
    newChat: n.newChat
      ? {
          cwd: n.newChat.cwd,
          name: baseName(n.newChat.cwd),
          projects: n.newChat.projects.map((root) => ({ root, name: baseName(root) }))
        }
      : null,
    place: n.place ? placeState(n.place, r.home) : null,
    viewer: n.viewers.length ? { title: n.viewers[n.viewers.length - 1].title } : null,
    requests: chat ? (r.permissions[chat.id] ?? []).map((q) => nativeRequest(q, chat.provider)) : []
  }
}

let lastComposerTop: number | null = null
const sent = new Map<string, string>()
let queued = false
let themeSent = ''

function publish(): void {
  if (queued) return
  queued = true
  // One post per frame at most: a streamed reply moves `statuses` and the
  // chat list many times a second, and only the last state of each matters.
  requestAnimationFrame(() => {
    queued = false
    const next = snapshot()
    const changed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(next)) {
      const json = JSON.stringify(value) ?? 'null'
      if (sent.get(key) !== json) {
        sent.set(key, json)
        changed[key] = value
      }
    }
    if (Object.keys(changed).length) handler?.postMessage({ type: 'state', state: changed })
  })
}

function publishTheme(): void {
  const next = theme()
  const json = JSON.stringify(next)
  if (json === themeSent) return
  themeSent = json
  // Brand colours can differ per appearance.
  marks = null
  publish()
  handler?.postMessage({ type: 'theme', theme: next })
}

function findModel(key: string): Parameters<Pickers['pickModel']>[0] | undefined {
  return useNative.getState().pickers?.p.models.find((m) => modelKey(m.provider, m.id) === key)
}

/** What a tap in the app does, by name. Each returns nothing the app waits on. */
const commands: Record<string, (...args: never[]) => unknown> = {
  navigate: (hash: string) => {
    if (location.hash !== hash) location.replace(hash)
  },
  /**
   * Where the app's bars end, in the web view's coordinates: the header's
   * bottom and the top of the composer with whatever floats over it (prompts,
   * an error). The bottom inset is that distance from the page's own bottom,
   * so it is right whatever height the web view has.
   */
  insets: (top: number, composerTop: number) => {
    const root = document.documentElement.style
    root.setProperty('--native-top', `${top}px`)
    root.setProperty('--native-bottom', `max(0px, calc(100dvh - ${composerTop}px))`)
    const delta = lastComposerTop === null ? 0 : lastComposerTop - composerTop
    lastComposerTop = composerTop
    window.dispatchEvent(new CustomEvent('carbon-native-insets', { detail: delta }))
  },
  /** Sent to the screen that is up: `scrollTop`, `viewChanges`. */
  screen: (name: string) => window.dispatchEvent(new CustomEvent('carbon-native', { detail: name })),
  setText: (text: string, caret: number) => useNative.getState().composerActions?.setText(text, caret),
  submit: () => useNative.getState().composerActions?.submit(),
  stop: () => useNative.getState().composerActions?.stop(),
  pick: (id: string) => useNative.getState().composerActions?.pick(id),
  dismissMenu: () => useNative.getState().composerActions?.dismissMenu(),
  removeAttachment: (id: string) => useNative.getState().composerActions?.removeAttachment(id),
  takeSuggestion: () => useNative.getState().composerActions?.takeSuggestion(),
  /** A file picked in the app, as base64: the page reads it in as the attach button would. */
  attach: (name: string, type: string, base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    useNative.getState().composerActions?.addFiles([new File([bytes], name, { type })])
  },
  sendQueuedNow: (chatId: string, id: string) => void useRemote.getState().sendQueuedNow(chatId, id),
  removeQueued: (chatId: string, id: string) => useRemote.getState().removeQueued(chatId, id),
  pickModel: (key: string) => {
    const pickers = useNative.getState().pickers
    const option = findModel(key)
    if (!pickers || !option) return
    const { replayed, ...pick } = pickers.p.pickModel(option)
    pickers.onChange(pick, true)
    if (Object.keys(replayed).length) pickers.onChange(replayed, false)
  },
  setEffort: (id: string) => useNative.getState().pickers?.onChange({ effort: id as OptionValues['effort'] }, true),
  setTier: (id: string) =>
    useNative.getState().pickers?.onChange({ serviceTier: id as OptionValues['serviceTier'] }, true),
  setMode: (id: string) =>
    useNative.getState().pickers?.onChange({ permissionMode: id as OptionValues['permissionMode'] }, true),
  rename: (chatId: string, title: string) => rename(chatId, title),
  setPinned: (chatId: string, pinned: boolean) => setPinned(chatId, pinned),
  setArchived: (chatId: string, archived: boolean) => setArchived(chatId, archived),
  /** Back, on the topmost layer the app is drawing a bar for. */
  closeViewer: () => {
    const { viewers } = useNative.getState()
    viewers[viewers.length - 1]?.close()
  },
  respond: (chatId: string, requestId: string, decision: PermissionDecision) =>
    useRemote.getState().respond(chatId, requestId, decision),
  answerQuestions: (chatId: string, requestId: string, values: string[][]) => {
    const r = useRemote.getState()
    const request = r.permissions[chatId]?.find((q) => q.id === requestId)
    const chat = r.chats.find((c) => c.id === chatId)
    if (request && chat) return r.respond(chatId, requestId, questionDecision(request, chat.provider, values))
  },
  setProject: (root: string) => useNative.getState().newChat?.pick(root),
  setPlace: (target: WorktreeTarget) => useNative.getState().place?.onChange(target),
  reloadPlace: () => useNative.getState().place?.reload(),
  branches: (cwd: string) => invoke<BranchRef[]>('git:local-branches', cwd),
  // Reads for the app's own screens, which only the page can make: the
  // pairing cookie is the web view's.
  changes: (chatId: string) => changes(chatId),
  diff: (chatId: string, path: string, scope?: 'repo') => diff(chatId, path, scope),
  canvas: (id: string) => invoke<Canvas | null>('canvas:get', id),
  // Coming back from the background needs nothing here: WebKit reports the
  // page hidden and visible again, and `state.ts` reconnects on that.
  dismissError: () => useRemote.getState().setError(null),
  clearDone: () => void useRemote.getState().clearDone(),
  refreshUsage: (force: boolean) => void useRemote.getState().refreshUsage(force),
  setSidebarDensity: (density: 'compact' | 'detailed') => {
    usePrefs.getState().setSidebarDensity(density)
    // Detailed rows name their branch; compact ones never read it.
    void useRemote.getState().refreshBranches()
  },
  setChatsPerProject: (n: number) => usePrefs.getState().setChatsPerProject(n),
  setSidebarProject: (root: string | null) => usePrefs.getState().setSidebarProject(root),
  placeChat: (zone: string, from: string, target: string, after: boolean) => placeChat(zone, from, { id: target, after }),
  /** One row off Done: the Mac clears its mark and says so to every screen. */
  markSeen: (chatId: string) => void markSeen([chatId]).catch(() => {}),
  /** Take back an armed cross-provider switch, as the page's Undo does. */
  undoSwitch: (chatId: string) => {
    const chat = useRemote.getState().chats.find((c) => c.id === chatId)
    if (chat) void useRemote.getState().setOptions(chat.id, { model: chat.model ?? '', modelProvider: chat.provider, remember: false })
  },
  setThemeMode: (mode: 'system' | 'light' | 'dark') => usePrefs.getState().setThemeMode(mode),
  setTheme: (id: string) => usePrefs.getState().setTheme(id),
  setTextSize: (index: number) => usePrefs.getState().setTextSize(index),
  setCodeSize: (px: number) => usePrefs.getState().setCodeSize(px)
}

/** Before the first render, inside the app only. */
export function installNativeBridge(): void {
  if (!isNative) return
  ;(window as unknown as { carbonNative: unknown }).carbonNative = {
    /** What a read answers comes back to the app, which awaits it. */
    call(name: string, ...args: unknown[]) {
      const run = commands[name] as ((...a: unknown[]) => unknown) | undefined
      if (!run) throw new Error(`Unknown command: ${name}`)
      return run(...args)
    }
  }
  document.documentElement.classList.add('native')
  useRemote.subscribe(publish)
  useNative.subscribe(publish)
  usePrefs.subscribe(() => {
    requestAnimationFrame(publishTheme)
    publish()
  })
  useApp.subscribe((s, prev) => {
    if (s.lightbox !== prev.lightbox) publish()
  })
  window.addEventListener('hashchange', publish)
  // The palette and the color mode are the page's (`prefs.ts`); the app wears
  // them so its bars meet the page without a seam.
  new MutationObserver(() => requestAnimationFrame(publishTheme)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-appearance']
  })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => requestAnimationFrame(publishTheme))
  requestAnimationFrame(publishTheme)
  publish()
}
