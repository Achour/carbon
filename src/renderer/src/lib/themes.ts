/**
 * Theme registry — the single source of truth for app themes.
 *
 * Each theme is a full set of the CSS custom properties consumed by
 * index.css / Tailwind tokens. `installThemes` injects one
 * `:root[data-theme='…']` block per theme; the attribute selector outranks
 * the `:root` / `.dark` fallback blocks in index.css, so those only matter
 * before the first `applyTheme` call.
 */

export interface ThemeDef {
  id: string
  name: string
  appearance: 'dark' | 'light'
  /** CSS custom properties, keyed without the leading `--`. */
  vars: Record<string, string>
}

const darkBase = {
  destructive: 'oklch(0.62 0.19 27)',
  'destructive-foreground': 'oklch(0.97 0.01 80)',
  success: 'oklch(0.72 0.14 150)',
  warning: 'oklch(0.78 0.14 75)'
}

const lightBase = {
  destructive: 'oklch(0.55 0.21 27)',
  'destructive-foreground': 'oklch(0.985 0.01 80)',
  success: 'oklch(0.6 0.13 150)',
  warning: 'oklch(0.72 0.15 75)'
}

export const THEMES: ThemeDef[] = [
  {
    id: 'graphite',
    name: 'Graphite',
    appearance: 'dark',
    vars: {
      background: 'oklch(0.221 0.004 100)',
      foreground: 'oklch(0.923 0.006 90)',
      card: 'oklch(0.248 0.004 100)',
      'card-foreground': 'oklch(0.923 0.006 90)',
      popover: 'oklch(0.26 0.004 100)',
      'popover-foreground': 'oklch(0.923 0.006 90)',
      primary: 'oklch(0.66 0.125 40)',
      'primary-foreground': 'oklch(0.18 0.01 60)',
      secondary: 'oklch(0.285 0.005 100)',
      'secondary-foreground': 'oklch(0.9 0.006 90)',
      muted: 'oklch(0.27 0.004 100)',
      'muted-foreground': 'oklch(0.63 0.008 85)',
      accent: 'oklch(0.29 0.005 100)',
      'accent-foreground': 'oklch(0.923 0.006 90)',
      border: 'oklch(1 0 0 / 8.5%)',
      input: 'oklch(1 0 0 / 12%)',
      ring: 'oklch(0.66 0.125 40 / 50%)',
      sidebar: 'oklch(0.199 0.004 100)',
      'sidebar-foreground': 'oklch(0.86 0.006 90)',
      'sidebar-accent': 'oklch(0.262 0.005 100)',
      'sidebar-border': 'oklch(1 0 0 / 7%)',
      'code-bg': 'oklch(0.185 0.004 100)',
      ...darkBase
    }
  },
  {
    id: 'midnight',
    name: 'Midnight',
    appearance: 'dark',
    vars: {
      background: 'oklch(0.215 0.018 260)',
      foreground: 'oklch(0.92 0.008 250)',
      card: 'oklch(0.243 0.02 260)',
      'card-foreground': 'oklch(0.92 0.008 250)',
      popover: 'oklch(0.255 0.02 260)',
      'popover-foreground': 'oklch(0.92 0.008 250)',
      primary: 'oklch(0.69 0.115 250)',
      'primary-foreground': 'oklch(0.16 0.02 260)',
      secondary: 'oklch(0.28 0.022 260)',
      'secondary-foreground': 'oklch(0.9 0.008 250)',
      muted: 'oklch(0.265 0.02 260)',
      'muted-foreground': 'oklch(0.63 0.015 250)',
      accent: 'oklch(0.285 0.024 260)',
      'accent-foreground': 'oklch(0.92 0.008 250)',
      border: 'oklch(1 0 0 / 9%)',
      input: 'oklch(1 0 0 / 12%)',
      ring: 'oklch(0.69 0.115 250 / 50%)',
      sidebar: 'oklch(0.193 0.017 260)',
      'sidebar-foreground': 'oklch(0.86 0.008 250)',
      'sidebar-accent': 'oklch(0.257 0.02 260)',
      'sidebar-border': 'oklch(1 0 0 / 7%)',
      'code-bg': 'oklch(0.18 0.016 260)',
      ...darkBase
    }
  },
  {
    id: 'dusk',
    name: 'Dusk',
    appearance: 'dark',
    vars: {
      background: 'oklch(0.222 0.014 325)',
      foreground: 'oklch(0.92 0.01 340)',
      card: 'oklch(0.25 0.016 325)',
      'card-foreground': 'oklch(0.92 0.01 340)',
      popover: 'oklch(0.262 0.016 325)',
      'popover-foreground': 'oklch(0.92 0.01 340)',
      primary: 'oklch(0.71 0.105 15)',
      'primary-foreground': 'oklch(0.17 0.015 340)',
      secondary: 'oklch(0.287 0.018 325)',
      'secondary-foreground': 'oklch(0.9 0.01 340)',
      muted: 'oklch(0.27 0.015 325)',
      'muted-foreground': 'oklch(0.635 0.015 330)',
      accent: 'oklch(0.292 0.019 325)',
      'accent-foreground': 'oklch(0.92 0.01 340)',
      border: 'oklch(1 0 0 / 8.5%)',
      input: 'oklch(1 0 0 / 12%)',
      ring: 'oklch(0.71 0.105 15 / 50%)',
      sidebar: 'oklch(0.2 0.013 325)',
      'sidebar-foreground': 'oklch(0.86 0.01 340)',
      'sidebar-accent': 'oklch(0.263 0.017 325)',
      'sidebar-border': 'oklch(1 0 0 / 7%)',
      'code-bg': 'oklch(0.186 0.013 325)',
      ...darkBase
    }
  },
  {
    id: 'carbon',
    name: 'Carbon',
    appearance: 'dark',
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
      ...darkBase
    }
  },
  {
    id: 'paper',
    name: 'Paper',
    appearance: 'light',
    vars: {
      background: 'oklch(0.984 0.003 90)',
      foreground: 'oklch(0.27 0.012 60)',
      card: 'oklch(1 0 0)',
      'card-foreground': 'oklch(0.27 0.012 60)',
      popover: 'oklch(1 0 0)',
      'popover-foreground': 'oklch(0.27 0.012 60)',
      primary: 'oklch(0.6 0.127 40)',
      'primary-foreground': 'oklch(0.985 0.01 80)',
      secondary: 'oklch(0.945 0.005 90)',
      'secondary-foreground': 'oklch(0.32 0.012 60)',
      muted: 'oklch(0.955 0.005 90)',
      'muted-foreground': 'oklch(0.54 0.012 75)',
      accent: 'oklch(0.938 0.006 90)',
      'accent-foreground': 'oklch(0.27 0.012 60)',
      border: 'oklch(0.9 0.006 90)',
      input: 'oklch(0.9 0.006 90)',
      ring: 'oklch(0.6 0.127 40 / 45%)',
      sidebar: 'oklch(0.962 0.004 90)',
      'sidebar-foreground': 'oklch(0.32 0.012 60)',
      'sidebar-accent': 'oklch(0.922 0.006 90)',
      'sidebar-border': 'oklch(0.9 0.006 90)',
      'code-bg': 'oklch(0.955 0.005 90)',
      ...lightBase
    }
  },
  {
    id: 'mist',
    name: 'Mist',
    appearance: 'light',
    vars: {
      background: 'oklch(0.978 0.003 240)',
      foreground: 'oklch(0.27 0.015 255)',
      card: 'oklch(1 0 0)',
      'card-foreground': 'oklch(0.27 0.015 255)',
      popover: 'oklch(1 0 0)',
      'popover-foreground': 'oklch(0.27 0.015 255)',
      primary: 'oklch(0.55 0.14 255)',
      'primary-foreground': 'oklch(0.985 0.005 240)',
      secondary: 'oklch(0.942 0.006 240)',
      'secondary-foreground': 'oklch(0.32 0.015 255)',
      muted: 'oklch(0.952 0.005 240)',
      'muted-foreground': 'oklch(0.53 0.02 250)',
      accent: 'oklch(0.934 0.008 240)',
      'accent-foreground': 'oklch(0.27 0.015 255)',
      border: 'oklch(0.898 0.008 240)',
      input: 'oklch(0.898 0.008 240)',
      ring: 'oklch(0.55 0.14 255 / 45%)',
      sidebar: 'oklch(0.958 0.005 240)',
      'sidebar-foreground': 'oklch(0.32 0.015 255)',
      'sidebar-accent': 'oklch(0.916 0.008 240)',
      'sidebar-border': 'oklch(0.898 0.008 240)',
      'code-bg': 'oklch(0.952 0.005 240)',
      ...lightBase
    }
  }
]

export const DEFAULT_THEME = 'carbon'

export function storedTheme(): string {
  // One-time: move installs still on the previous default ('graphite') to the
  // new default. A deliberate choice of any other theme is left untouched.
  if (!localStorage.getItem('themeDefaultV2')) {
    localStorage.setItem('themeDefaultV2', '1')
    if ((localStorage.getItem('theme') ?? 'graphite') === 'graphite') {
      localStorage.removeItem('theme')
      localStorage.removeItem('themeAppearance')
    }
  }
  const raw = localStorage.getItem('theme') ?? DEFAULT_THEME
  // Builds before the theme registry stored just 'dark' / 'light'.
  const id = raw === 'dark' ? 'graphite' : raw === 'light' ? 'paper' : raw
  return THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME
}

export function applyTheme(id: string): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]
  document.documentElement.dataset.theme = theme.id
  document.documentElement.classList.toggle('dark', theme.appearance === 'dark')
  localStorage.setItem('theme', theme.id)
  // index.html reads this before first paint to set the `dark` class early.
  localStorage.setItem('themeAppearance', theme.appearance)
}

// Code font size (code blocks, file viewer, diffs) via --code-font-size.
export const CODE_FONT_MIN = 10
export const CODE_FONT_MAX = 20
export const CODE_FONT_DEFAULT = 12

export function storedCodeFontSize(): number {
  const n = Number(localStorage.getItem('codeFontSize'))
  return Number.isFinite(n) ? Math.min(CODE_FONT_MAX, Math.max(CODE_FONT_MIN, n)) : CODE_FONT_DEFAULT
}

export function applyCodeFontSize(px: number): void {
  document.documentElement.style.setProperty('--code-font-size', `${px}px`)
  localStorage.setItem('codeFontSize', String(px))
}

/** Injects a stylesheet with one `:root[data-theme='…']` block per theme. */
export function installThemes(): void {
  if (document.getElementById('theme-vars')) return
  const css = THEMES.map(
    (t) =>
      `:root[data-theme='${t.id}'] {\n${Object.entries(t.vars)
        .map(([k, v]) => `  --${k}: ${v};`)
        .join('\n')}\n}`
  ).join('\n')
  const style = document.createElement('style')
  style.id = 'theme-vars'
  style.textContent = css
  document.head.appendChild(style)
}
