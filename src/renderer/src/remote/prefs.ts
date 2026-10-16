import { create } from 'zustand'
import {
  applyTheme,
  currentDockIconPalette,
  installThemes,
  storedTheme,
  type ResolvedAppearance,
  type ThemeMode
} from '@/lib/themes'

/**
 * How this phone draws the app: text size, code size, color mode and palette,
 * and the sidebar's shape.
 *
 * Per device and kept in the page's own `localStorage`, never on the Mac. The
 * relay's allowlist leaves settings out on purpose (`REMOTE_CHANNELS`), and a
 * phone wanting larger type than the desktop is the normal case, not a
 * conflict to sync. The origin is the phone's own, so the desktop's theme keys
 * (`theme`, `themeMode`) can be reused here without the two ever meeting.
 *
 * Text size is a `zoom` on the reading surfaces, not a font-size variable:
 * the transcript is the desktop's components, sized in px throughout, and
 * the desktop already settled zoom over a text scale (`docs/chat-layout.md`).
 * The phone simply has no ⌘+ to do it with, so this stands in for it.
 */

/** The steps the text-size control walks, as zoom factors. */
export const TEXT_SIZES = [0.85, 0.92, 1, 1.08, 1.17, 1.28, 1.4] as const
const TEXT_DEFAULT = 2

export const CODE_MIN = 10
export const CODE_MAX = 18
/** What the phone drew before this was a setting. */
export const CODE_DEFAULT = 12

/** The desktop's two sidebar shapes (`docs/sidebar.md`). */
export type SidebarDensity = 'compact' | 'detailed'

/** Chats each project shows before "Show more", in the compact sidebar. */
export const CHATS_PER_PROJECT_MIN = 3
export const CHATS_PER_PROJECT_MAX = 20
/** The phone's fold before this was a setting; a screen of thumb rows is shorter than the desktop's. */
export const CHATS_PER_PROJECT_DEFAULT = 5

const TEXT_KEY = 'carbon.remote.textSize'
const DENSITY_KEY = 'carbon.remote.sidebarDensity'
const PER_PROJECT_KEY = 'carbon.remote.chatsPerProject'
const CODE_KEY = 'carbon.remote.codeSize'
const PROJECT_KEY = 'carbon.remote.project'
/** Read by `remote.html` before any script loads: the first frame's colour. */
const PAINT_KEY = 'carbon.remote.paint'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* per-device convenience; the setting still applies for this visit */
  }
}

function readInt(key: string, min: number, max: number, fallback: number): number {
  const raw = read(key)
  const n = raw === null ? NaN : Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

/** The desktop defaults to Dark; a phone follows the phone unless told otherwise. */
function storedMode(): ThemeMode {
  const raw = read('themeMode')
  return raw === 'dark' || raw === 'light' ? raw : 'system'
}

interface Prefs {
  themeId: string
  themeMode: ThemeMode
  appearance: ResolvedAppearance
  /** An index into `TEXT_SIZES`. */
  textSize: number
  codeSize: number
  sidebarDensity: SidebarDensity
  chatsPerProject: number
  /** The sidebar's project filter: a project root, or null for all of them. */
  sidebarProject: string | null
  setTheme(id: string): void
  setThemeMode(mode: ThemeMode): void
  setTextSize(index: number): void
  setCodeSize(px: number): void
  setSidebarDensity(density: SidebarDensity): void
  setChatsPerProject(n: number): void
  setSidebarProject(root: string | null): void
}

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

function paint(themeId: string, mode: ThemeMode): ResolvedAppearance {
  // `applyTheme` resolves System against `prefers-color-scheme`, which on a
  // phone is the phone's own appearance: nothing here forces it.
  const appearance = applyTheme(themeId, mode)
  const root = document.documentElement
  root.style.removeProperty('--paint')
  const background = currentDockIconPalette().background
  // The status bar wears the page's colour in either appearance, so both
  // metas get the one in use rather than keeping their `media` split.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = background
  }
  // Remembered per appearance, so a cold start in System mode paints the
  // right one of the two before the stylesheet arrives.
  let saved: { theme?: string; light?: string; dark?: string } = {}
  try {
    saved = JSON.parse(read(PAINT_KEY) ?? '{}') as typeof saved
  } catch {
    saved = {}
  }
  if (saved.theme !== themeId) saved = { theme: themeId }
  saved[appearance] = background
  write(PAINT_KEY, JSON.stringify(saved))
  return appearance
}

function applyText(index: number): void {
  document.documentElement.style.setProperty('--reading-zoom', String(TEXT_SIZES[index]))
}

function applyCode(px: number): void {
  document.documentElement.style.setProperty('--code-font-size', `${px}px`)
}

export const usePrefs = create<Prefs>((set, get) => ({
  themeId: storedTheme(),
  themeMode: storedMode(),
  appearance: systemDark.matches ? 'dark' : 'light',
  textSize: readInt(TEXT_KEY, 0, TEXT_SIZES.length - 1, TEXT_DEFAULT),
  codeSize: readInt(CODE_KEY, CODE_MIN, CODE_MAX, CODE_DEFAULT),
  sidebarDensity: read(DENSITY_KEY) === 'detailed' ? 'detailed' : 'compact',
  chatsPerProject: readInt(PER_PROJECT_KEY, CHATS_PER_PROJECT_MIN, CHATS_PER_PROJECT_MAX, CHATS_PER_PROJECT_DEFAULT),
  sidebarProject: read(PROJECT_KEY) || null,
  setTheme: (id) => set({ themeId: id, appearance: paint(id, get().themeMode) }),
  setThemeMode: (mode) => set({ themeMode: mode, appearance: paint(get().themeId, mode) }),
  setTextSize: (index) => {
    const next = Math.max(0, Math.min(TEXT_SIZES.length - 1, index))
    write(TEXT_KEY, String(next))
    applyText(next)
    set({ textSize: next })
  },
  setCodeSize: (px) => {
    const next = Math.max(CODE_MIN, Math.min(CODE_MAX, px))
    write(CODE_KEY, String(next))
    applyCode(next)
    set({ codeSize: next })
  },
  setSidebarDensity: (density) => {
    write(DENSITY_KEY, density)
    set({ sidebarDensity: density })
  },
  setChatsPerProject: (n) => {
    const next = Math.max(CHATS_PER_PROJECT_MIN, Math.min(CHATS_PER_PROJECT_MAX, n))
    write(PER_PROJECT_KEY, String(next))
    set({ chatsPerProject: next })
  },
  setSidebarProject: (root) => {
    try {
      if (root) localStorage.setItem(PROJECT_KEY, root)
      else localStorage.removeItem(PROJECT_KEY)
    } catch {
      /* per-device convenience; the filter still applies for this visit */
    }
    set({ sidebarProject: root })
  }
}))

/** Before the first render: the palette, both sizes, and System kept live. */
export function installPrefs(): void {
  installThemes()
  const s = usePrefs.getState()
  usePrefs.setState({ appearance: paint(s.themeId, s.themeMode) })
  applyText(s.textSize)
  applyCode(s.codeSize)
  systemDark.addEventListener('change', () => {
    const { themeId, themeMode } = usePrefs.getState()
    if (themeMode === 'system') usePrefs.setState({ appearance: paint(themeId, themeMode) })
  })
}
