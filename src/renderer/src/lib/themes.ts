/**
 * Theme registry — the single source of truth for app themes.
 *
 * Six curated themes, each **authored in both modes**. The previous registry
 * derived every light mode from one `lightThemeVars(accent)` helper that mixed
 * the accent into a fixed near-white base at 2–10%, so 22 of the 28 themes had
 * the same light mode wearing a different button. A set this small is small
 * enough to write both halves properly, which is the whole point of trimming it.
 *
 * Themes are picked by **background family**, not by accent — neutral, black,
 * warm, cool, green, violet. Recoloring one accent over the same gray chrome is
 * what made the old set feel like one theme in 28 hats.
 *
 * Everything is OKLCH so the ladders are perceptually even across hues: a step
 * of 0.03 L reads as the same step whether the chrome is amber or navy, which
 * plain hex cannot promise. `installThemes` injects one data-attribute block per
 * theme × appearance, so switching never requires a renderer reload.
 */
import type { DockIconPalette } from '@shared/types'

export interface ThemeDef {
  id: string
  name: string
  /** Dark-mode CSS custom properties, keyed without the leading `--`. */
  vars: Record<string, string>
  /** Light-mode counterpart — authored, not derived. */
  lightVars: Record<string, string>
}

export type ThemeMode = 'dark' | 'light' | 'system'
export type ResolvedAppearance = 'dark' | 'light'

/** OKLCH lightness for each chrome level. Not ordered — named by role. */
interface Ladder {
  sidebar: number
  code: number
  background: number
  card: number
  sidebarAccent: number
  muted: number
  popover: number
  secondary: number
  /**
   * Hover/highlight level. Must sit a visible step away from `popover` and
   * `secondary` in the direction of the foreground, or every menu highlight and
   * secondary-button hover repaints the color the surface already has and reads
   * as no hover at all.
   */
  hover: number
  text: number
  mutedText: number
}

/**
 * `primary` does two jobs that pull in opposite directions: it is text/icons on
 * `background` (~27 call sites) *and* the fill behind `primary-foreground` on
 * buttons (~26). On a dark theme, satisfying both means a **light** accent with
 * a **dark** label — a saturated mid-tone reads fine as text but cannot carry a
 * white one (Iris at L 0.68 scored 2.97:1). Darkening instead doesn't work
 * either: for blue at C 0.19 the two requirements cross with no L between them,
 * and lightening past L≈0.64 leaves sRGB entirely. Hence every dark accent here
 * sits near L 0.74 with the chroma that lightness can actually hold.
 */
interface Accent {
  l: number
  c: number
  h: number
  /** Which end of the ramp `primary-foreground` comes from. */
  on: 'light' | 'dark'
}

interface ModeSpec {
  ladder: Ladder
  /**
   * Chroma carried by the chrome surfaces — the theme's entire personality.
   * Keep it small: chrome that reads as *paint* competes with the content.
   */
  tint: number
  /** Chroma carried by text. Below `tint`, or long prose looks stained. */
  textTint: number
  /** Hue shared by chrome and text. The accent carries its own. */
  hue: number
  primary: Accent
  border?: string
  input?: string
  sidebarBorder?: string
}

interface ThemeSpec {
  id: string
  name: string
  dark: ModeSpec
  light: ModeSpec
}

/** Trims float noise (0.93 - 0.07 = 0.8600000000000001) out of the CSS. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function oklch(l: number, c: number, h: number, alpha?: number): string {
  const base = `${round(l)} ${round(c)} ${h}`
  return alpha === undefined ? `oklch(${base})` : `oklch(${base} / ${alpha}%)`
}

/**
 * Moves a lightness `amount` toward `target`. Sidebar and secondary text sit a
 * fixed step *below* body text in contrast, which means a lower L in dark mode
 * and a higher one in light mode — the same intent, opposite arithmetic.
 */
function toward(from: number, target: number, amount: number): number {
  return from + Math.sign(target - from) * amount
}

/** Status colors are palette-independent: they must read as red/green/amber. */
const STATUS: Record<ResolvedAppearance, Record<string, string>> = {
  dark: {
    destructive: 'oklch(0.62 0.19 27)',
    'destructive-foreground': 'oklch(0.97 0.01 80)',
    success: 'oklch(0.72 0.14 150)',
    warning: 'oklch(0.78 0.14 75)'
  },
  light: {
    destructive: 'oklch(0.53 0.2 27)',
    'destructive-foreground': 'oklch(0.99 0 0)',
    success: 'oklch(0.55 0.13 150)',
    warning: 'oklch(0.58 0.12 75)'
  }
}

function modeVars(spec: ModeSpec, appearance: ResolvedAppearance): Record<string, string> {
  const { ladder, tint, textTint, hue, primary } = spec
  const surface = (l: number): string => oklch(l, tint, hue)
  const text = (l: number): string => oklch(l, textTint, hue)
  const dark = appearance === 'dark'

  return {
    background: surface(ladder.background),
    foreground: text(ladder.text),
    card: surface(ladder.card),
    'card-foreground': text(ladder.text),
    popover: surface(ladder.popover),
    'popover-foreground': text(ladder.text),
    primary: oklch(primary.l, primary.c, primary.h),
    'primary-foreground':
      primary.on === 'light' ? 'oklch(0.99 0 0)' : surface(ladder.background),
    secondary: surface(ladder.secondary),
    'secondary-foreground': text(toward(ladder.text, ladder.background, 0.03)),
    muted: surface(ladder.muted),
    'muted-foreground': text(ladder.mutedText),
    accent: surface(ladder.hover),
    'accent-foreground': text(ladder.text),
    border: spec.border ?? (dark ? 'oklch(1 0 0 / 9%)' : oklch(0.89, tint, hue)),
    input: spec.input ?? (dark ? 'oklch(1 0 0 / 12%)' : oklch(0.86, tint, hue)),
    ring: oklch(primary.l, primary.c, primary.h, 40),
    sidebar: surface(ladder.sidebar),
    'sidebar-foreground': text(toward(ladder.text, ladder.background, 0.07)),
    'sidebar-accent': surface(ladder.sidebarAccent),
    'sidebar-border':
      spec.sidebarBorder ?? (dark ? 'oklch(1 0 0 / 7%)' : oklch(0.89, tint, hue)),
    'code-bg': surface(ladder.code),
    ...STATUS[appearance]
  }
}

function theme(spec: ThemeSpec): ThemeDef {
  return {
    id: spec.id,
    name: spec.name,
    vars: modeVars(spec.dark, 'dark'),
    lightVars: modeVars(spec.light, 'light')
  }
}

const SPECS: ThemeSpec[] = [
  /**
   * Carbon — neutral graphite. The default, and its dark mode is unchanged:
   * every value below reproduces the original literal exactly. Only the light
   * mode is new, because Carbon's used to be the generic derived one.
   */
  {
    id: 'carbon',
    name: 'Carbon',
    dark: {
      ladder: {
        sidebar: 0.178,
        code: 0.165,
        background: 0.2,
        card: 0.23,
        sidebarAccent: 0.246,
        muted: 0.255,
        popover: 0.245,
        secondary: 0.27,
        hover: 0.275,
        text: 0.93,
        mutedText: 0.62
      },
      tint: 0,
      textTint: 0,
      hue: 0,
      primary: { l: 0.93, c: 0, h: 0, on: 'dark' }
    },
    light: {
      ladder: {
        sidebar: 0.968,
        code: 0.958,
        background: 0.985,
        card: 1,
        sidebarAccent: 0.93,
        muted: 0.965,
        popover: 1,
        secondary: 0.955,
        hover: 0.93,
        text: 0.25,
        mutedText: 0.5
      },
      tint: 0,
      textTint: 0,
      hue: 0,
      primary: { l: 0.32, c: 0, h: 0, on: 'light' }
    }
  },

  /**
   * Obsidian — near-black, high contrast, electric blue. The one place borders
   * are lifted above the shared default: at this lightness a 9% white hairline
   * disappears and every panel edge melts into the next.
   */
  {
    id: 'obsidian',
    name: 'Obsidian',
    dark: {
      ladder: {
        sidebar: 0.105,
        code: 0.095,
        background: 0.135,
        card: 0.175,
        sidebarAccent: 0.185,
        muted: 0.18,
        popover: 0.195,
        secondary: 0.21,
        hover: 0.245,
        text: 0.96,
        mutedText: 0.6
      },
      tint: 0.008,
      textTint: 0.006,
      hue: 255,
      primary: { l: 0.74, c: 0.125, h: 255, on: 'dark' },
      border: 'oklch(1 0 0 / 11%)',
      input: 'oklch(1 0 0 / 14%)',
      sidebarBorder: 'oklch(1 0 0 / 8%)'
    },
    light: {
      ladder: {
        sidebar: 0.972,
        code: 0.963,
        background: 0.99,
        card: 1,
        sidebarAccent: 0.935,
        muted: 0.968,
        popover: 1,
        secondary: 0.958,
        hover: 0.932,
        text: 0.22,
        mutedText: 0.48
      },
      tint: 0.004,
      textTint: 0.005,
      hue: 255,
      primary: { l: 0.52, c: 0.2, h: 258, on: 'light' }
    }
  },

  /** Ember — warm charcoal chrome, amber accent. Low blue light, cozy. */
  {
    id: 'ember',
    name: 'Ember',
    dark: {
      ladder: {
        sidebar: 0.172,
        code: 0.155,
        background: 0.202,
        card: 0.238,
        sidebarAccent: 0.252,
        muted: 0.252,
        popover: 0.258,
        secondary: 0.282,
        hover: 0.312,
        text: 0.93,
        mutedText: 0.635
      },
      tint: 0.016,
      textTint: 0.012,
      hue: 62,
      primary: { l: 0.76, c: 0.135, h: 65, on: 'dark' }
    },
    light: {
      ladder: {
        sidebar: 0.963,
        code: 0.952,
        background: 0.985,
        card: 0.998,
        sidebarAccent: 0.928,
        muted: 0.962,
        popover: 0.998,
        secondary: 0.95,
        hover: 0.925,
        text: 0.26,
        mutedText: 0.5
      },
      tint: 0.009,
      textTint: 0.008,
      hue: 70,
      primary: { l: 0.55, c: 0.14, h: 55, on: 'light' }
    }
  },

  /** Tide — deep navy chrome, cyan-blue accent. */
  {
    id: 'tide',
    name: 'Tide',
    dark: {
      ladder: {
        sidebar: 0.175,
        code: 0.158,
        background: 0.205,
        card: 0.24,
        sidebarAccent: 0.254,
        muted: 0.252,
        popover: 0.258,
        secondary: 0.283,
        hover: 0.313,
        text: 0.93,
        mutedText: 0.64
      },
      tint: 0.022,
      textTint: 0.014,
      hue: 248,
      primary: { l: 0.72, c: 0.12, h: 225, on: 'dark' }
    },
    light: {
      ladder: {
        sidebar: 0.962,
        code: 0.951,
        background: 0.985,
        card: 0.999,
        sidebarAccent: 0.925,
        muted: 0.961,
        popover: 0.999,
        secondary: 0.949,
        hover: 0.922,
        text: 0.25,
        mutedText: 0.49
      },
      tint: 0.009,
      textTint: 0.009,
      hue: 245,
      primary: { l: 0.52, c: 0.15, h: 248, on: 'light' }
    }
  },

  /** Moss — desaturated forest chrome, sage accent. Calm, not Matrix-green. */
  {
    id: 'moss',
    name: 'Moss',
    dark: {
      ladder: {
        sidebar: 0.172,
        code: 0.155,
        background: 0.202,
        card: 0.237,
        sidebarAccent: 0.251,
        muted: 0.249,
        popover: 0.255,
        secondary: 0.279,
        hover: 0.308,
        text: 0.93,
        mutedText: 0.63
      },
      tint: 0.017,
      textTint: 0.011,
      hue: 152,
      primary: { l: 0.75, c: 0.115, h: 150, on: 'dark' }
    },
    light: {
      ladder: {
        sidebar: 0.961,
        code: 0.95,
        background: 0.984,
        card: 0.998,
        sidebarAccent: 0.924,
        muted: 0.96,
        popover: 0.998,
        secondary: 0.948,
        hover: 0.921,
        text: 0.25,
        mutedText: 0.49
      },
      tint: 0.009,
      textTint: 0.008,
      hue: 150,
      primary: { l: 0.5, c: 0.11, h: 152, on: 'light' }
    }
  },

  /** Iris — deep plum chrome, violet accent. */
  {
    id: 'iris',
    name: 'Iris',
    dark: {
      ladder: {
        sidebar: 0.175,
        code: 0.158,
        background: 0.205,
        card: 0.24,
        sidebarAccent: 0.254,
        muted: 0.252,
        popover: 0.258,
        secondary: 0.283,
        hover: 0.313,
        text: 0.93,
        mutedText: 0.64
      },
      tint: 0.02,
      textTint: 0.013,
      hue: 295,
      primary: { l: 0.74, c: 0.14, h: 296, on: 'dark' }
    },
    light: {
      ladder: {
        sidebar: 0.962,
        code: 0.951,
        background: 0.985,
        card: 0.999,
        sidebarAccent: 0.925,
        muted: 0.961,
        popover: 0.999,
        secondary: 0.949,
        hover: 0.922,
        text: 0.25,
        mutedText: 0.49
      },
      tint: 0.009,
      textTint: 0.009,
      hue: 295,
      primary: { l: 0.5, c: 0.19, h: 296, on: 'light' }
    }
  }
]

export const THEMES: ThemeDef[] = SPECS.map(theme)

export const DEFAULT_THEME = 'carbon'
export const DEFAULT_THEME_MODE: ThemeMode = 'dark'

export function storedTheme(): string {
  const raw = localStorage.getItem('theme') ?? DEFAULT_THEME
  // Builds before the registry stored appearance names instead of theme IDs.
  const id = raw === 'dark' || raw === 'light' ? DEFAULT_THEME : raw
  // Also the migration path off a retired theme id: anything not in the
  // registry lands on Carbon rather than an unstyled app.
  return THEMES.some((candidate) => candidate.id === id) ? id : DEFAULT_THEME
}

export function storedThemeMode(): ThemeMode {
  const raw = localStorage.getItem('themeMode')
  return raw === 'dark' || raw === 'light' || raw === 'system' ? raw : DEFAULT_THEME_MODE
}

export function resolveAppearance(
  mode: ThemeMode,
  systemDark?: boolean
): ResolvedAppearance {
  if (mode !== 'system') return mode
  const dark =
    systemDark ?? window.matchMedia('(prefers-color-scheme: dark)').matches
  return dark ? 'dark' : 'light'
}

export function applyTheme(id: string, mode: ThemeMode): ResolvedAppearance {
  const selected =
    THEMES.find((candidate) => candidate.id === id) ??
    THEMES.find((candidate) => candidate.id === DEFAULT_THEME)!
  const appearance = resolveAppearance(mode)
  document.documentElement.dataset.theme = selected.id
  document.documentElement.dataset.appearance = appearance
  document.documentElement.classList.toggle('dark', appearance === 'dark')
  document.documentElement.style.colorScheme = appearance
  localStorage.setItem('theme', selected.id)
  localStorage.setItem('themeMode', mode)
  return appearance
}

let dockColorCanvas: HTMLCanvasElement | null = null
let dockColorProbe: HTMLSpanElement | null = null

function cssVariableHex(name: string, fallback: string): string {
  dockColorCanvas ??= document.createElement('canvas')
  dockColorCanvas.width = 1
  dockColorCanvas.height = 1
  const context = dockColorCanvas.getContext('2d', { willReadFrequently: true })
  if (!context) return fallback

  dockColorProbe ??= document.createElement('span')
  if (!dockColorProbe.isConnected) {
    dockColorProbe.style.cssText = 'position:fixed;pointer-events:none;visibility:hidden'
    document.body.appendChild(dockColorProbe)
  }
  dockColorProbe.style.color = `var(--${name})`
  const color = getComputedStyle(dockColorProbe).color

  context.clearRect(0, 0, 1, 1)
  context.fillStyle = fallback
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** Concrete sRGB colors suitable for Electron's runtime SVG Dock icon. */
export function currentDockIconPalette(): DockIconPalette {
  return {
    background: cssVariableHex('background', '#1c1c1c'),
    surface: cssVariableHex('card', '#2b2b2b'),
    code: cssVariableHex('code-bg', '#131313'),
    foreground: cssVariableHex('foreground', '#f0f0f0'),
    primary: cssVariableHex('primary', '#e4e4e4')
  }
}

// Translucent sidebar (macOS vibrancy). Renderer-owned like the other
// appearance prefs; the native side is toggled over IPC from the store.
export function storedTranslucent(): boolean {
  return localStorage.getItem('translucentSidebar') === 'true'
}

/** Sets the `data-translucent` flag index.css keys the sidebar tint off. */
export function applyTranslucent(on: boolean): void {
  document.documentElement.dataset.translucent = on ? 'true' : 'false'
}

// Code font size (code blocks, file viewer, diffs) via --code-font-size.
export const CODE_FONT_MIN = 10
export const CODE_FONT_MAX = 24
export const CODE_FONT_DEFAULT = 14

export function storedCodeFontSize(): number {
  // One-time: an earlier build read an unset value as 0 and clamped it to the
  // minimum (10), then persisted that — clear it so the real default applies.
  if (!localStorage.getItem('codeFontV2')) {
    localStorage.setItem('codeFontV2', '1')
    localStorage.removeItem('codeFontSize')
  }
  const raw = localStorage.getItem('codeFontSize')
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? Math.min(CODE_FONT_MAX, Math.max(CODE_FONT_MIN, n)) : CODE_FONT_DEFAULT
}

// Applies the CSS var only; persistence is the caller's job (setCodeFontSize),
// so a future default change isn't shadowed by an auto-persisted value.
export function applyCodeFontSize(px: number): void {
  document.documentElement.style.setProperty('--code-font-size', `${px}px`)
}

/** Injects dark and light variable blocks for every theme. */
export function installThemes(): void {
  if (document.getElementById('theme-vars')) return
  const block = (
    def: ThemeDef,
    appearance: ResolvedAppearance,
    vars: Record<string, string>
  ): string =>
    `:root[data-theme='${def.id}'][data-appearance='${appearance}'] {\n${Object.entries(vars)
      .map(([key, value]) => `  --${key}: ${value};`)
      .join('\n')}\n}`
  const css = THEMES.flatMap((def) => [
    block(def, 'dark', def.vars),
    block(def, 'light', def.lightVars)
  ]).join('\n')
  const style = document.createElement('style')
  style.id = 'theme-vars'
  style.textContent = css
  document.head.appendChild(style)
}
