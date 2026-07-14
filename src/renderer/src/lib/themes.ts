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
  // Carbon color variants — the exact Carbon neutral base, only the primary
  // accent (and matching focus ring) is swapped for a vibrant hue.
  ...(
    [
      { id: 'carbon-blue', name: 'Carbon Blue', primary: 'oklch(0.62 0.2 258)', onPrimary: 'oklch(0.98 0 0)' },
      { id: 'carbon-violet', name: 'Carbon Violet', primary: 'oklch(0.58 0.22 292)', onPrimary: 'oklch(0.98 0 0)' },
      { id: 'carbon-pink', name: 'Carbon Pink', primary: 'oklch(0.65 0.24 340)', onPrimary: 'oklch(0.98 0 0)' },
      { id: 'carbon-rose', name: 'Carbon Rose', primary: 'oklch(0.64 0.22 18)', onPrimary: 'oklch(0.98 0 0)' },
      { id: 'carbon-amber', name: 'Carbon Amber', primary: 'oklch(0.77 0.15 72)', onPrimary: 'oklch(0.2 0 0)' },
      { id: 'carbon-lime', name: 'Carbon Lime', primary: 'oklch(0.82 0.19 128)', onPrimary: 'oklch(0.2 0 0)' },
      { id: 'carbon-emerald', name: 'Carbon Emerald', primary: 'oklch(0.7 0.16 160)', onPrimary: 'oklch(0.2 0 0)' },
      { id: 'carbon-cyan', name: 'Carbon Cyan', primary: 'oklch(0.74 0.13 205)', onPrimary: 'oklch(0.2 0 0)' }
    ] as const
  ).map(
    (c): ThemeDef => ({
      id: c.id,
      name: c.name,
      appearance: 'dark',
      vars: {
        background: 'oklch(0.2 0 0)',
        foreground: 'oklch(0.93 0 0)',
        card: 'oklch(0.23 0 0)',
        'card-foreground': 'oklch(0.93 0 0)',
        popover: 'oklch(0.245 0 0)',
        'popover-foreground': 'oklch(0.93 0 0)',
        primary: c.primary,
        'primary-foreground': c.onPrimary,
        secondary: 'oklch(0.27 0 0)',
        'secondary-foreground': 'oklch(0.9 0 0)',
        muted: 'oklch(0.255 0 0)',
        'muted-foreground': 'oklch(0.62 0 0)',
        accent: 'oklch(0.275 0 0)',
        'accent-foreground': 'oklch(0.93 0 0)',
        border: 'oklch(1 0 0 / 9%)',
        input: 'oklch(1 0 0 / 12%)',
        ring: c.primary.replace(')', ' / 45%)'),
        sidebar: 'oklch(0.178 0 0)',
        'sidebar-foreground': 'oklch(0.86 0 0)',
        'sidebar-accent': 'oklch(0.246 0 0)',
        'sidebar-border': 'oklch(1 0 0 / 7%)',
        'code-bg': 'oklch(0.165 0 0)',
        ...darkBase
      }
    })
  ),
  {
    id: 'nord',
    name: 'Nord',
    appearance: 'dark',
    vars: {
      background: 'oklch(0.223 0.012 255)',
      foreground: 'oklch(0.925 0.008 250)',
      card: 'oklch(0.252 0.013 255)',
      'card-foreground': 'oklch(0.925 0.008 250)',
      popover: 'oklch(0.264 0.013 255)',
      'popover-foreground': 'oklch(0.925 0.008 250)',
      primary: 'oklch(0.74 0.09 225)',
      'primary-foreground': 'oklch(0.18 0.02 255)',
      secondary: 'oklch(0.29 0.014 255)',
      'secondary-foreground': 'oklch(0.9 0.008 250)',
      muted: 'oklch(0.272 0.013 255)',
      'muted-foreground': 'oklch(0.66 0.012 250)',
      accent: 'oklch(0.3 0.015 255)',
      'accent-foreground': 'oklch(0.925 0.008 250)',
      border: 'oklch(1 0 0 / 9%)',
      input: 'oklch(1 0 0 / 12%)',
      ring: 'oklch(0.74 0.09 225 / 50%)',
      sidebar: 'oklch(0.2 0.011 255)',
      'sidebar-foreground': 'oklch(0.86 0.008 250)',
      'sidebar-accent': 'oklch(0.264 0.013 255)',
      'sidebar-border': 'oklch(1 0 0 / 7%)',
      'code-bg': 'oklch(0.188 0.011 255)',
      ...darkBase
    }
  },
  {
    id: 'forest',
    name: 'Forest',
    appearance: 'dark',
    vars: {
      background: 'oklch(0.222 0.012 155)',
      foreground: 'oklch(0.92 0.01 140)',
      card: 'oklch(0.25 0.013 155)',
      'card-foreground': 'oklch(0.92 0.01 140)',
      popover: 'oklch(0.262 0.013 155)',
      'popover-foreground': 'oklch(0.92 0.01 140)',
      primary: 'oklch(0.75 0.115 145)',
      'primary-foreground': 'oklch(0.17 0.02 150)',
      secondary: 'oklch(0.287 0.015 155)',
      'secondary-foreground': 'oklch(0.9 0.01 140)',
      muted: 'oklch(0.27 0.013 155)',
      'muted-foreground': 'oklch(0.64 0.015 150)',
      accent: 'oklch(0.293 0.016 155)',
      'accent-foreground': 'oklch(0.92 0.01 140)',
      border: 'oklch(1 0 0 / 8.5%)',
      input: 'oklch(1 0 0 / 12%)',
      ring: 'oklch(0.75 0.115 145 / 50%)',
      sidebar: 'oklch(0.2 0.011 155)',
      'sidebar-foreground': 'oklch(0.86 0.01 140)',
      'sidebar-accent': 'oklch(0.262 0.014 155)',
      'sidebar-border': 'oklch(1 0 0 / 7%)',
      'code-bg': 'oklch(0.187 0.011 155)',
      ...darkBase
    }
  },
  {
    id: 'rose',
    name: 'Rosé',
    appearance: 'dark',
    vars: {
      background: 'oklch(0.21 0.018 305)',
      foreground: 'oklch(0.9 0.012 310)',
      card: 'oklch(0.238 0.02 305)',
      'card-foreground': 'oklch(0.9 0.012 310)',
      popover: 'oklch(0.25 0.02 305)',
      'popover-foreground': 'oklch(0.9 0.012 310)',
      primary: 'oklch(0.77 0.07 25)',
      'primary-foreground': 'oklch(0.18 0.015 305)',
      secondary: 'oklch(0.278 0.022 305)',
      'secondary-foreground': 'oklch(0.88 0.012 310)',
      muted: 'oklch(0.262 0.02 305)',
      'muted-foreground': 'oklch(0.63 0.016 305)',
      accent: 'oklch(0.285 0.024 305)',
      'accent-foreground': 'oklch(0.9 0.012 310)',
      border: 'oklch(1 0 0 / 8.5%)',
      input: 'oklch(1 0 0 / 12%)',
      ring: 'oklch(0.77 0.07 25 / 50%)',
      sidebar: 'oklch(0.186 0.016 305)',
      'sidebar-foreground': 'oklch(0.85 0.012 310)',
      'sidebar-accent': 'oklch(0.252 0.02 305)',
      'sidebar-border': 'oklch(1 0 0 / 7%)',
      'code-bg': 'oklch(0.175 0.015 305)',
      ...darkBase
    }
  },
  {
    id: 'solar',
    name: 'Solar',
    appearance: 'dark',
    vars: {
      background: 'oklch(0.235 0.03 210)',
      foreground: 'oklch(0.87 0.018 195)',
      card: 'oklch(0.262 0.032 210)',
      'card-foreground': 'oklch(0.87 0.018 195)',
      popover: 'oklch(0.274 0.032 210)',
      'popover-foreground': 'oklch(0.87 0.018 195)',
      primary: 'oklch(0.68 0.13 245)',
      'primary-foreground': 'oklch(0.16 0.02 210)',
      secondary: 'oklch(0.3 0.03 210)',
      'secondary-foreground': 'oklch(0.86 0.018 195)',
      muted: 'oklch(0.28 0.03 210)',
      'muted-foreground': 'oklch(0.66 0.025 205)',
      accent: 'oklch(0.305 0.032 210)',
      'accent-foreground': 'oklch(0.87 0.018 195)',
      border: 'oklch(1 0 0 / 9%)',
      input: 'oklch(1 0 0 / 12%)',
      ring: 'oklch(0.68 0.13 245 / 50%)',
      sidebar: 'oklch(0.21 0.028 210)',
      'sidebar-foreground': 'oklch(0.82 0.018 195)',
      'sidebar-accent': 'oklch(0.272 0.032 210)',
      'sidebar-border': 'oklch(1 0 0 / 7%)',
      'code-bg': 'oklch(0.2 0.028 210)',
      ...darkBase
    }
  },
  {
    id: 'ember',
    name: 'Ember',
    appearance: 'dark',
    vars: {
      background: 'oklch(0.215 0.008 45)',
      foreground: 'oklch(0.92 0.01 60)',
      card: 'oklch(0.244 0.009 45)',
      'card-foreground': 'oklch(0.92 0.01 60)',
      popover: 'oklch(0.256 0.009 45)',
      'popover-foreground': 'oklch(0.92 0.01 60)',
      primary: 'oklch(0.7 0.15 45)',
      'primary-foreground': 'oklch(0.17 0.02 45)',
      secondary: 'oklch(0.283 0.01 45)',
      'secondary-foreground': 'oklch(0.9 0.01 60)',
      muted: 'oklch(0.266 0.009 45)',
      'muted-foreground': 'oklch(0.64 0.012 50)',
      accent: 'oklch(0.29 0.011 45)',
      'accent-foreground': 'oklch(0.92 0.01 60)',
      border: 'oklch(1 0 0 / 8.5%)',
      input: 'oklch(1 0 0 / 12%)',
      ring: 'oklch(0.7 0.15 45 / 50%)',
      sidebar: 'oklch(0.194 0.007 45)',
      'sidebar-foreground': 'oklch(0.86 0.01 60)',
      'sidebar-accent': 'oklch(0.258 0.01 45)',
      'sidebar-border': 'oklch(1 0 0 / 7%)',
      'code-bg': 'oklch(0.18 0.007 45)',
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
  },
  {
    id: 'sepia',
    name: 'Sepia',
    appearance: 'light',
    vars: {
      background: 'oklch(0.96 0.012 75)',
      foreground: 'oklch(0.3 0.02 55)',
      card: 'oklch(0.985 0.008 75)',
      'card-foreground': 'oklch(0.3 0.02 55)',
      popover: 'oklch(0.985 0.008 75)',
      'popover-foreground': 'oklch(0.3 0.02 55)',
      primary: 'oklch(0.52 0.1 50)',
      'primary-foreground': 'oklch(0.98 0.01 80)',
      secondary: 'oklch(0.93 0.014 75)',
      'secondary-foreground': 'oklch(0.34 0.02 55)',
      muted: 'oklch(0.938 0.012 75)',
      'muted-foreground': 'oklch(0.5 0.02 60)',
      accent: 'oklch(0.922 0.016 75)',
      'accent-foreground': 'oklch(0.3 0.02 55)',
      border: 'oklch(0.88 0.014 75)',
      input: 'oklch(0.88 0.014 75)',
      ring: 'oklch(0.52 0.1 50 / 45%)',
      sidebar: 'oklch(0.942 0.012 75)',
      'sidebar-foreground': 'oklch(0.34 0.02 55)',
      'sidebar-accent': 'oklch(0.9 0.016 75)',
      'sidebar-border': 'oklch(0.88 0.014 75)',
      'code-bg': 'oklch(0.938 0.012 75)',
      ...lightBase
    }
  },
  {
    id: 'meadow',
    name: 'Meadow',
    appearance: 'light',
    vars: {
      background: 'oklch(0.976 0.008 150)',
      foreground: 'oklch(0.28 0.02 160)',
      card: 'oklch(1 0 0)',
      'card-foreground': 'oklch(0.28 0.02 160)',
      popover: 'oklch(1 0 0)',
      'popover-foreground': 'oklch(0.28 0.02 160)',
      primary: 'oklch(0.52 0.12 155)',
      'primary-foreground': 'oklch(0.985 0.01 150)',
      secondary: 'oklch(0.94 0.01 150)',
      'secondary-foreground': 'oklch(0.32 0.02 160)',
      muted: 'oklch(0.95 0.008 150)',
      'muted-foreground': 'oklch(0.5 0.02 155)',
      accent: 'oklch(0.93 0.012 150)',
      'accent-foreground': 'oklch(0.28 0.02 160)',
      border: 'oklch(0.9 0.012 150)',
      input: 'oklch(0.9 0.012 150)',
      ring: 'oklch(0.52 0.12 155 / 45%)',
      sidebar: 'oklch(0.956 0.008 150)',
      'sidebar-foreground': 'oklch(0.32 0.02 160)',
      'sidebar-accent': 'oklch(0.914 0.012 150)',
      'sidebar-border': 'oklch(0.9 0.012 150)',
      'code-bg': 'oklch(0.95 0.008 150)',
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
