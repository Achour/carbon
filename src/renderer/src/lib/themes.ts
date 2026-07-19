/**
 * Theme registry — the single source of truth for app themes.
 *
 * Each theme is a full set of the CSS custom properties consumed by
 * index.css / Tailwind. `installThemes` injects one data-attribute block per
 * theme so switching themes never requires a renderer reload.
 */
import type { DockIconPalette } from '@shared/types'

export interface ThemeDef {
  id: string
  name: string
  /** Dark-mode CSS custom properties, keyed without the leading `--`. */
  vars: Record<string, string>
  /** Light-mode counterpart; keeps this theme's accent identity. */
  lightVars: Record<string, string>
}

export type ThemeMode = 'dark' | 'light' | 'system'
export type ResolvedAppearance = 'dark' | 'light'

interface DarkThemePalette {
  id: string
  name: string
  background: string
  surface: string
  surfaceRaised: string
  sidebar: string
  code: string
  foreground: string
  mutedForeground: string
  primary: string
  primaryForeground?: string
  border?: string
  /** Targeted overrides for light themes that would otherwise look alike. */
  lightOverrides?: Record<string, string>
}

const darkBase = {
  destructive: '#ef6a67',
  'destructive-foreground': '#fff7f2',
  success: '#72c48f',
  warning: '#e5b567'
}

function lightThemeVars(
  accent: string,
  overrides: Record<string, string> = {}
): Record<string, string> {
  const primary = `color-mix(in oklab, ${accent} 68%, #111827)`
  return {
    background: `color-mix(in oklab, ${accent} 2%, #fbfbfc)`,
    foreground: '#202124',
    card: '#ffffff',
    'card-foreground': '#202124',
    popover: '#ffffff',
    'popover-foreground': '#202124',
    primary,
    'primary-foreground': '#ffffff',
    secondary: `color-mix(in oklab, ${accent} 5%, #f1f3f5)`,
    'secondary-foreground': '#292b2f',
    muted: `color-mix(in oklab, ${accent} 4%, #f3f4f6)`,
    'muted-foreground': '#666b73',
    accent: `color-mix(in oklab, ${accent} 9%, #edf0f3)`,
    'accent-foreground': '#202124',
    destructive: '#cf222e',
    'destructive-foreground': '#ffffff',
    border: `color-mix(in oklab, ${accent} 8%, #daddE2)`,
    input: `color-mix(in oklab, ${accent} 10%, #d4d7dc)`,
    ring: `color-mix(in oklab, ${accent} 42%, transparent)`,
    sidebar: `color-mix(in oklab, ${accent} 4%, #f5f6f8)`,
    'sidebar-foreground': '#303238',
    'sidebar-accent': `color-mix(in oklab, ${accent} 9%, #e9ecef)`,
    'sidebar-border': `color-mix(in oklab, ${accent} 8%, #daddE2)`,
    'code-bg': `color-mix(in oklab, ${accent} 3%, #f2f3f5)`,
    success: '#238636',
    warning: '#9a6700',
    ...overrides
  }
}

function darkTheme(palette: DarkThemePalette): ThemeDef {
  const border = palette.border ?? 'rgb(255 255 255 / 9%)'
  return {
    id: palette.id,
    name: palette.name,
    vars: {
      background: palette.background,
      foreground: palette.foreground,
      card: palette.surface,
      'card-foreground': palette.foreground,
      popover: palette.surfaceRaised,
      'popover-foreground': palette.foreground,
      primary: palette.primary,
      'primary-foreground': palette.primaryForeground ?? palette.background,
      secondary: palette.surfaceRaised,
      'secondary-foreground': palette.foreground,
      muted: palette.surface,
      'muted-foreground': palette.mutedForeground,
      accent: palette.surfaceRaised,
      'accent-foreground': palette.foreground,
      border,
      input: 'rgb(255 255 255 / 13%)',
      ring: `color-mix(in oklab, ${palette.primary} 52%, transparent)`,
      sidebar: palette.sidebar,
      'sidebar-foreground': palette.foreground,
      'sidebar-accent': palette.surface,
      'sidebar-border': border,
      'code-bg': palette.code,
      ...darkBase
    },
    lightVars: lightThemeVars(palette.primary, palette.lightOverrides)
  }
}

/**
 * Carbon is intentionally kept byte-for-byte equivalent to the original
 * neutral palette. It remains the default and the first item in the picker.
 */
const carbonTheme: ThemeDef = {
  id: 'carbon',
  name: 'Carbon',
  vars: {
    background: 'oklch(0.2 0 0)',
    foreground: 'oklch(0.93 0 0)',
    card: 'oklch(0.23 0 0)',
    'card-foreground': 'oklch(0.93 0 0)',
    popover: 'oklch(0.245 0 0)',
    'popover-foreground': 'oklch(0.93 0 0)',
    primary: 'oklch(0.93 0 0)',
    'primary-foreground': 'oklch(0.2 0 0)',
    secondary: 'oklch(0.27 0 0)',
    'secondary-foreground': 'oklch(0.9 0 0)',
    muted: 'oklch(0.255 0 0)',
    'muted-foreground': 'oklch(0.62 0 0)',
    accent: 'oklch(0.275 0 0)',
    'accent-foreground': 'oklch(0.93 0 0)',
    border: 'oklch(1 0 0 / 9%)',
    input: 'oklch(1 0 0 / 12%)',
    ring: 'oklch(0.93 0 0 / 40%)',
    sidebar: 'oklch(0.178 0 0)',
    'sidebar-foreground': 'oklch(0.86 0 0)',
    'sidebar-accent': 'oklch(0.246 0 0)',
    'sidebar-border': 'oklch(1 0 0 / 7%)',
    'code-bg': 'oklch(0.165 0 0)',
    destructive: 'oklch(0.62 0.19 27)',
    'destructive-foreground': 'oklch(0.97 0.01 80)',
    success: 'oklch(0.72 0.14 150)',
    warning: 'oklch(0.78 0.14 75)'
  },
  lightVars: lightThemeVars('#5f6368')
}

const codexThemes: ThemeDef[] = [
  darkTheme({
    id: 'absolutely',
    name: 'Absolutely',
    background: '#1f1f1e',
    surface: '#2a2927',
    surfaceRaised: '#373431',
    sidebar: '#191918',
    code: '#151514',
    foreground: '#f4f1ed',
    mutedForeground: '#aaa39b',
    primary: '#db8b70'
  }),
  darkTheme({
    id: 'ayu',
    name: 'Ayu',
    background: '#0b0e14',
    surface: '#11151c',
    surfaceRaised: '#1b202a',
    sidebar: '#070a0f',
    code: '#080b10',
    foreground: '#bfbdb6',
    mutedForeground: '#6c7380',
    primary: '#e6b450'
  }),
  darkTheme({
    id: 'catppuccin',
    name: 'Catppuccin',
    background: '#1e1e2e',
    surface: '#313244',
    surfaceRaised: '#45475a',
    sidebar: '#181825',
    code: '#11111b',
    foreground: '#cdd6f4',
    mutedForeground: '#7f849c',
    primary: '#cba6f7'
  }),
  darkTheme({
    id: 'codex',
    name: 'Codex',
    background: '#111214',
    surface: '#1c1e22',
    surfaceRaised: '#292c31',
    sidebar: '#0c0d0f',
    code: '#08090b',
    foreground: '#f3f4f6',
    mutedForeground: '#8b9099',
    primary: '#3b82f6',
    primaryForeground: '#ffffff'
  }),
  darkTheme({
    id: 'dracula',
    name: 'Dracula',
    background: '#282a36',
    surface: '#343746',
    surfaceRaised: '#44475a',
    sidebar: '#21222c',
    code: '#191a21',
    foreground: '#f8f8f2',
    mutedForeground: '#9da0b3',
    primary: '#ff79c6'
  }),
  darkTheme({
    id: 'everforest',
    name: 'Everforest',
    background: '#2d353b',
    surface: '#343f44',
    surfaceRaised: '#3d484d',
    sidebar: '#272e33',
    code: '#232a2e',
    foreground: '#d3c6aa',
    mutedForeground: '#859289',
    primary: '#a7c080'
  }),
  darkTheme({
    id: 'github',
    name: 'GitHub',
    background: '#0d1117',
    surface: '#161b22',
    surfaceRaised: '#21262d',
    sidebar: '#010409',
    code: '#090c10',
    foreground: '#e6edf3',
    mutedForeground: '#7d8590',
    primary: '#2f81f7',
    primaryForeground: '#ffffff',
    border: '#30363d',
    lightOverrides: {
      background: '#ffffff',
      card: '#f6f8fa',
      popover: '#ffffff',
      primary: '#0969da',
      secondary: '#f6f8fa',
      muted: '#f6f8fa',
      accent: '#ddf4ff',
      border: '#d0d7de',
      input: '#d0d7de',
      ring: 'rgb(9 105 218 / 35%)',
      sidebar: '#f6f8fa',
      'sidebar-accent': '#eaeef2',
      'sidebar-border': '#d0d7de',
      'code-bg': '#f6f8fa'
    }
  }),
  darkTheme({
    id: 'gruvbox',
    name: 'Gruvbox',
    background: '#282828',
    surface: '#3c3836',
    surfaceRaised: '#504945',
    sidebar: '#1d2021',
    code: '#1d2021',
    foreground: '#ebdbb2',
    mutedForeground: '#a89984',
    primary: '#83a598'
  }),
  darkTheme({
    id: 'linear',
    name: 'Linear',
    background: '#111113',
    surface: '#1b1b1f',
    surfaceRaised: '#28282f',
    sidebar: '#0b0b0d',
    code: '#09090b',
    foreground: '#f5f5f6',
    mutedForeground: '#8b8b95',
    primary: '#7c6df2',
    primaryForeground: '#ffffff',
    lightOverrides: {
      background: '#f7f7f8',
      card: '#ffffff',
      popover: '#ffffff',
      primary: '#5e6ad2',
      secondary: '#efeff2',
      muted: '#f0f0f2',
      accent: '#e7e5fb',
      border: '#d8d8de',
      input: '#d1d1d8',
      sidebar: '#efeff2',
      'sidebar-accent': '#e2e2e8',
      'sidebar-border': '#d8d8de',
      'code-bg': '#eeeef1'
    }
  }),
  darkTheme({
    id: 'lobster',
    name: 'Lobster',
    background: '#111827',
    surface: '#1f2937',
    surfaceRaised: '#303b4e',
    sidebar: '#0b1220',
    code: '#080e19',
    foreground: '#f8fafc',
    mutedForeground: '#8d99ab',
    primary: '#ff6b6b',
    lightOverrides: {
      background: '#fff8f5',
      card: '#fffdfc',
      popover: '#fffdfc',
      primary: '#d94b4b',
      secondary: '#fbe9e5',
      muted: '#f9eeeb',
      accent: '#f7ddd7',
      border: '#e7cbc4',
      input: '#dfc2ba',
      sidebar: '#fceeea',
      'sidebar-accent': '#f5dcd5',
      'sidebar-border': '#e7cbc4',
      'code-bg': '#f7e5df'
    }
  }),
  darkTheme({
    id: 'material',
    name: 'Material',
    background: '#212121',
    surface: '#2b2b2b',
    surfaceRaised: '#383838',
    sidebar: '#191919',
    code: '#151515',
    foreground: '#eeffff',
    mutedForeground: '#9e9e9e',
    primary: '#80cbc4',
    lightOverrides: {
      background: '#f5fbfa',
      card: '#ffffff',
      popover: '#ffffff',
      primary: '#00796b',
      secondary: '#e0f2f1',
      muted: '#edf5f4',
      accent: '#cce9e6',
      border: '#c6dad8',
      input: '#b8cfcc',
      sidebar: '#edf7f6',
      'sidebar-accent': '#d7ecea',
      'sidebar-border': '#c6dad8',
      'code-bg': '#e8f3f2'
    }
  }),
  darkTheme({
    id: 'matrix',
    name: 'Matrix',
    background: '#020806',
    surface: '#07120d',
    surfaceRaised: '#0b1d13',
    sidebar: '#000302',
    code: '#000000',
    foreground: '#b9ffd1',
    mutedForeground: '#4f8b63',
    primary: '#63ff87'
  }),
  darkTheme({
    id: 'monokai',
    name: 'Monokai',
    background: '#272822',
    surface: '#34352d',
    surfaceRaised: '#41423a',
    sidebar: '#1e1f1a',
    code: '#181915',
    foreground: '#f8f8f2',
    mutedForeground: '#a5a58d',
    primary: '#e6db74'
  }),
  darkTheme({
    id: 'night-owl',
    name: 'Night Owl',
    background: '#011627',
    surface: '#0b253a',
    surfaceRaised: '#12344b',
    sidebar: '#01111d',
    code: '#00101b',
    foreground: '#d6deeb',
    mutedForeground: '#637777',
    primary: '#82aaff',
    lightOverrides: {
      background: '#fbfbfd',
      foreground: '#403f53',
      card: '#ffffff',
      'card-foreground': '#403f53',
      popover: '#ffffff',
      'popover-foreground': '#403f53',
      primary: '#994cc3',
      secondary: '#f0f0f7',
      muted: '#f2f2f8',
      'muted-foreground': '#76758a',
      accent: '#ece8f3',
      'accent-foreground': '#403f53',
      border: '#d9d8e5',
      input: '#cfcedd',
      sidebar: '#f0f0f7',
      'sidebar-foreground': '#403f53',
      'sidebar-accent': '#e5e4ef',
      'sidebar-border': '#d9d8e5',
      'code-bg': '#ededf5'
    }
  }),
  darkTheme({
    id: 'nord',
    name: 'Nord',
    background: '#2e3440',
    surface: '#3b4252',
    surfaceRaised: '#434c5e',
    sidebar: '#272c36',
    code: '#242933',
    foreground: '#eceff4',
    mutedForeground: '#8b96ad',
    primary: '#88c0d0'
  }),
  darkTheme({
    id: 'notion',
    name: 'Notion',
    background: '#191919',
    surface: '#242424',
    surfaceRaised: '#303030',
    sidebar: '#121212',
    code: '#101010',
    foreground: '#f7f7f5',
    mutedForeground: '#9b9a97',
    primary: '#529cca'
  }),
  darkTheme({
    id: 'one',
    name: 'One',
    background: '#282c34',
    surface: '#323842',
    surfaceRaised: '#3e4451',
    sidebar: '#21252b',
    code: '#1e2227',
    foreground: '#abb2bf',
    mutedForeground: '#7f848e',
    primary: '#61afef'
  }),
  darkTheme({
    id: 'oscorange',
    name: 'Oscorange',
    background: '#0c0c0d',
    surface: '#181719',
    surfaceRaised: '#272429',
    sidebar: '#060607',
    code: '#030304',
    foreground: '#f3eee9',
    mutedForeground: '#8f8580',
    primary: '#ff9b5e'
  }),
  darkTheme({
    id: 'raycast',
    name: 'Raycast',
    background: '#171719',
    surface: '#222225',
    surfaceRaised: '#303034',
    sidebar: '#101012',
    code: '#0c0c0e',
    foreground: '#f8f8f8',
    mutedForeground: '#96969f',
    primary: '#ff6363'
  }),
  darkTheme({
    id: 'rose-pine',
    name: 'Rose Pine',
    background: '#191724',
    surface: '#26233a',
    surfaceRaised: '#393552',
    sidebar: '#12101c',
    code: '#0f0e17',
    foreground: '#e0def4',
    mutedForeground: '#908caa',
    primary: '#ebbcba'
  }),
  darkTheme({
    id: 'sentry',
    name: 'Sentry',
    background: '#181225',
    surface: '#241b35',
    surfaceRaised: '#34264a',
    sidebar: '#100b19',
    code: '#0d0915',
    foreground: '#f5f3f7',
    mutedForeground: '#9587a6',
    primary: '#7553ff',
    primaryForeground: '#ffffff'
  }),
  darkTheme({
    id: 'solarized',
    name: 'Solarized',
    background: '#002b36',
    surface: '#073642',
    surfaceRaised: '#124754',
    sidebar: '#00212a',
    code: '#001e26',
    foreground: '#eee8d5',
    mutedForeground: '#839496',
    primary: '#dc322f',
    lightOverrides: {
      background: '#fdf6e3',
      foreground: '#586e75',
      card: '#fffaf0',
      'card-foreground': '#586e75',
      popover: '#eee8d5',
      'popover-foreground': '#586e75',
      primary: '#268bd2',
      'primary-foreground': '#ffffff',
      secondary: '#eee8d5',
      'secondary-foreground': '#586e75',
      muted: '#eee8d5',
      'muted-foreground': '#839496',
      accent: '#e7dfc8',
      'accent-foreground': '#586e75',
      border: '#d8cfb8',
      input: '#cec4aa',
      ring: 'rgb(38 139 210 / 35%)',
      sidebar: '#eee8d5',
      'sidebar-foreground': '#586e75',
      'sidebar-accent': '#e3dbc4',
      'sidebar-border': '#d8cfb8',
      'code-bg': '#eee8d5',
      success: '#859900',
      warning: '#b58900'
    }
  }),
  darkTheme({
    id: 'temple',
    name: 'Temple',
    background: '#06100c',
    surface: '#0d1d16',
    surfaceRaised: '#173226',
    sidebar: '#030806',
    code: '#010403',
    foreground: '#e4f2c0',
    mutedForeground: '#7f9d78',
    primary: '#d4f542'
  }),
  darkTheme({
    id: 'tokyo-night',
    name: 'Tokyo Night',
    background: '#1a1b26',
    surface: '#24283b',
    surfaceRaised: '#32364d',
    sidebar: '#13141c',
    code: '#101117',
    foreground: '#c0caf5',
    mutedForeground: '#737aa2',
    primary: '#7aa2f7'
  }),
  darkTheme({
    id: 'vercel',
    name: 'Vercel',
    background: '#000000',
    surface: '#111111',
    surfaceRaised: '#1f1f1f',
    sidebar: '#000000',
    code: '#000000',
    foreground: '#ededed',
    mutedForeground: '#888888',
    primary: '#0070f3',
    primaryForeground: '#ffffff',
    border: '#2e2e2e'
  }),
  darkTheme({
    id: 'vs-code-plus',
    name: 'VS Code Plus',
    background: '#1e1e1e',
    surface: '#252526',
    surfaceRaised: '#333333',
    sidebar: '#181818',
    code: '#151515',
    foreground: '#d4d4d4',
    mutedForeground: '#858585',
    primary: '#3794ff',
    primaryForeground: '#ffffff'
  }),
  darkTheme({
    id: 'xcode',
    name: 'Xcode',
    background: '#1f2430',
    surface: '#292e3a',
    surfaceRaised: '#343b49',
    sidebar: '#191d27',
    code: '#151820',
    foreground: '#d7dae0',
    mutedForeground: '#7f8799',
    primary: '#4da6ff'
  })
]

export const THEMES: ThemeDef[] = [carbonTheme, ...codexThemes]

export const DEFAULT_THEME = 'carbon'
export const DEFAULT_THEME_MODE: ThemeMode = 'dark'

export function storedTheme(): string {
  const raw = localStorage.getItem('theme') ?? DEFAULT_THEME
  // Builds before the registry stored appearance names instead of theme IDs.
  const id = raw === 'dark' || raw === 'light' ? DEFAULT_THEME : raw
  return THEMES.some((theme) => theme.id === id) ? id : DEFAULT_THEME
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

export function varsForAppearance(
  theme: ThemeDef,
  appearance: ResolvedAppearance
): Record<string, string> {
  return appearance === 'dark' ? theme.vars : theme.lightVars
}

export function applyTheme(id: string, mode: ThemeMode): ResolvedAppearance {
  const theme =
    THEMES.find((candidate) => candidate.id === id) ??
    THEMES.find((candidate) => candidate.id === DEFAULT_THEME)!
  const appearance = resolveAppearance(mode)
  document.documentElement.dataset.theme = theme.id
  document.documentElement.dataset.appearance = appearance
  document.documentElement.classList.toggle('dark', appearance === 'dark')
  document.documentElement.style.colorScheme = appearance
  localStorage.setItem('theme', theme.id)
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
    theme: ThemeDef,
    appearance: ResolvedAppearance,
    vars: Record<string, string>
  ): string =>
    `:root[data-theme='${theme.id}'][data-appearance='${appearance}'] {\n${Object.entries(vars)
      .map(([key, value]) => `  --${key}: ${value};`)
      .join('\n')}\n}`
  const css = THEMES.flatMap((theme) => [
    block(theme, 'dark', theme.vars),
    block(theme, 'light', theme.lightVars)
  ]).join('\n')
  const style = document.createElement('style')
  style.id = 'theme-vars'
  style.textContent = css
  document.head.appendChild(style)
}
