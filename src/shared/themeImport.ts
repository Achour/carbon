/**
 * Turns a theme someone else wrote into Carbon's variable set — a VS Code color
 * theme (pasted, dropped, or pulled out of an Open VSX extension) or Carbon's
 * own export. See `docs/themes.md` for why each mapping is
 * the one it is.
 *
 * Dependency-free on purpose: main resolves an extension's `include` chain with
 * it, the renderer converts with it, and `node --test` runs it directly.
 */

export type Appearance = 'dark' | 'light'

/** The chrome contract every theme must fill — `modeVars`' keys in `lib/themes.ts`. */
export const THEME_VARS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'border',
  'input',
  'ring',
  'sidebar',
  'sidebar-foreground',
  'sidebar-accent',
  'sidebar-border',
  'code-bg',
  'destructive',
  'destructive-foreground',
  'success',
  'warning'
] as const

/** Optional: absent, `index.css`'s own token colors apply. */
export const SYNTAX_VARS = [
  'syn-comment',
  'syn-keyword',
  'syn-string',
  'syn-number',
  'syn-function',
  'syn-variable',
  'syn-builtin',
  'syn-meta'
] as const

const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white'
] as const

/** Optional: absent, the terminal keeps its built-in ANSI palette. */
export const TERMINAL_VARS = [
  ...ANSI.map((name) => `term-${name}`),
  ...ANSI.map((name) => `term-bright-${name}`)
]

const ALL_VARS = new Set<string>([...THEME_VARS, ...SYNTAX_VARS, ...TERMINAL_VARS])

export interface ImportedTheme {
  name: string
  appearance: Appearance
  /** Every `THEME_VARS` key, plus whichever syntax and terminal colors the source had. */
  vars: Record<string, string>
}

export interface ImportOptions {
  /** Overrides the file's own name — the manifest label for an extension's theme. */
  name?: string
  /** Overrides detection — the manifest's `uiTheme` for an extension's theme. */
  appearance?: Appearance
}

// ---------------------------------------------------------------- colors ---

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

function parseHex(text: string): Rgba | null {
  const hex = text.slice(1)
  if (!/^[0-9a-f]+$/i.test(hex)) return null
  const full =
    hex.length === 3 || hex.length === 4 ? [...hex].map((ch) => ch + ch).join('') : hex
  if (full.length !== 6 && full.length !== 8) return null
  const at = (i: number): number => parseInt(full.slice(i, i + 2), 16)
  return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 }
}

/** `62%` → 0.62, `0.62` → 0.62; `scale` is what a bare number is out of. */
function component(text: string, scale: number): number {
  return text.endsWith('%') ? parseFloat(text) / 100 : parseFloat(text) / scale
}

function splitArgs(inner: string): string[] {
  return inner
    .replace(/\s*\/\s*/, ' / ')
    .split(/[\s,]+/)
    .filter(Boolean)
}

function alphaOf(args: string[], index: number): number {
  const slash = args.indexOf('/')
  const raw = slash >= 0 ? args[slash + 1] : args[index]
  return raw === undefined ? 1 : clamp01(component(raw, 1))
}

function srgbFromLinear(x: number): number {
  const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
  return Math.round(clamp01(v) * 255)
}

function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    srgbFromLinear(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    srgbFromLinear(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    srgbFromLinear(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)
  ]
}

/** Hex, `rgb()`/`rgba()` and `oklch()` — what VS Code and Carbon each write. */
export function parseColor(input: unknown): Rgba | null {
  if (typeof input !== 'string') return null
  const text = input.trim().toLowerCase()
  if (text.startsWith('#')) return parseHex(text)
  // Numbers, units and separators only: these strings end up in a <style>
  // block, and `rgb(1,2,3) } body { … }` must not parse as a color.
  const fn = /^(rgba?|oklch)\(([0-9a-z.%\s,/+-]*)\)$/.exec(text)
  if (!fn) return null
  const args = splitArgs(fn[2])
  const nums = args.filter((arg) => arg !== '/')
  if (nums.length < 3 || nums.slice(0, 3).some((n) => !Number.isFinite(parseFloat(n)))) {
    return null
  }
  if (fn[1] === 'oklch') {
    const [r, g, b] = oklchToRgb(
      component(nums[0], 1),
      nums[1].endsWith('%') ? (parseFloat(nums[1]) / 100) * 0.4 : parseFloat(nums[1]),
      parseFloat(nums[2])
    )
    return { r, g, b, a: alphaOf(args, 3) }
  }
  const channel = (n: string): number => Math.round(clamp01(component(n, 255)) * 255)
  return { r: channel(nums[0]), g: channel(nums[1]), b: channel(nums[2]), a: alphaOf(args, 3) }
}

function toHex(color: Rgba): string {
  const pair = (n: number): string => Math.round(n).toString(16).padStart(2, '0')
  const base = `#${pair(color.r)}${pair(color.g)}${pair(color.b)}`
  return color.a >= 1 ? base : base + pair(color.a * 255)
}

/** Paints `top` over an opaque `bottom` — VS Code's selections are mostly translucent. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1
  }
}

function mix(from: Rgba, to: Rgba, amount: number): Rgba {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
    a: 1
  }
}

function withAlpha(color: Rgba, a: number): Rgba {
  return { ...color, a }
}

function luminance(color: Rgba): number {
  const lin = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b)
}

export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }

function isDark(color: Rgba): boolean {
  return contrast(color, WHITE) > contrast(color, BLACK)
}

/** Palette-independent defaults: errors must still read red on any ground. */
const STATUS: Record<Appearance, Record<string, string>> = {
  dark: {
    destructive: '#e5534b',
    'destructive-foreground': '#ffffff',
    success: '#57c785',
    warning: '#e3b341'
  },
  light: {
    destructive: '#cf222e',
    'destructive-foreground': '#ffffff',
    success: '#1a7f37',
    warning: '#9a6700'
  }
}

// -------------------------------------------------------------- derivation ---

/**
 * A seed color, as one source supplies it. Translucent values are composited
 * over the surface they would be painted on, so a `#ffffff14` hover means what
 * it meant in VS Code instead of a near-invisible wash on Carbon's own chrome.
 */
type Seeds = Partial<Record<string, string>>

/**
 * Fills every `THEME_VARS` key from whatever `seeds` supplies. Each seed is
 * taken only while it stays legible against the surface it is drawn on — a
 * theme is free to give its sidebar text a contrast VS Code's sidebar can live
 * with, but Carbon draws more on that surface than a file tree.
 */
export function deriveVars(seeds: Seeds, appearance: Appearance): Record<string, string> {
  const dark = appearance === 'dark'
  const bg = solid(seeds.background, null) ?? (dark ? parseHex('#1e1e1e')! : WHITE)
  const fallbackFg = dark ? mix(bg, WHITE, 0.88) : mix(bg, BLACK, 0.85)
  const fg = legible(seeds.foreground, bg, 4.5) ?? fallbackFg
  const toward = (amount: number): Rgba => mix(bg, fg, amount)
  const away = (amount: number): Rgba => mix(bg, dark ? BLACK : WHITE, amount)
  const out: Record<string, string> = {}
  const put = (key: string, value: Rgba | string): void => {
    out[key] = typeof value === 'string' ? value : toHex(value)
  }

  put('background', bg)
  put('foreground', fg)

  const card = stepped(seeds.card, bg) ?? (dark ? toward(0.04) : away(0.6))
  const popover = stepped(seeds.popover, bg) ?? (dark ? toward(0.06) : away(0.7))
  put('card', card)
  put('card-foreground', legible(seeds['card-foreground'], card, 4.5) ?? fg)
  put('popover', popover)
  put('popover-foreground', legible(seeds['popover-foreground'], popover, 4.5) ?? fg)

  const secondary = stepped(seeds.secondary, bg) ?? toward(dark ? 0.09 : 0.05)
  put('secondary', secondary)
  put(
    'secondary-foreground',
    legible(seeds['secondary-foreground'], secondary, 4.5) ?? mix(fg, bg, 0.05)
  )
  const muted = stepped(seeds.muted, bg) ?? toward(dark ? 0.06 : 0.03)
  put('muted', muted)
  put('muted-foreground', legible(seeds['muted-foreground'], bg, 3) ?? mix(fg, bg, 0.38))
  const hover = solid(seeds.accent, popover)
  put(
    'accent',
    hover && contrast(hover, fg) >= 4 ? hover : toward(dark ? 0.1 : 0.07)
  )
  put('accent-foreground', fg)

  const primary = legible(seeds.primary, bg, 2.5) ?? fg
  put('primary', primary)
  put(
    'primary-foreground',
    legible(seeds['primary-foreground'], primary, 4.5) ?? bestOn(primary, [bg, fg, WHITE, BLACK])
  )
  put('ring', visible(seeds.ring) ?? withAlpha(primary, 0.4))

  put('border', visible(seeds.border) ?? withAlpha(fg, dark ? 0.1 : 0.12))
  put('input', visible(seeds.input) ?? withAlpha(fg, dark ? 0.14 : 0.16))

  const sidebar = solid(seeds.sidebar, bg) ?? (dark ? away(0.12) : toward(0.025))
  put('sidebar', sidebar)
  const sidebarFg = legible(seeds['sidebar-foreground'], sidebar, 4.5) ?? mix(fg, sidebar, 0.08)
  put('sidebar-foreground', sidebarFg)
  const sidebarAccent = stepped(seeds['sidebar-accent'], sidebar)
  put(
    'sidebar-accent',
    sidebarAccent && contrast(sidebarAccent, sidebarFg) >= 3.5
      ? sidebarAccent
      : mix(sidebar, fg, dark ? 0.08 : 0.07)
  )
  put('sidebar-border', visible(seeds['sidebar-border']) ?? withAlpha(fg, dark ? 0.08 : 0.1))
  put('code-bg', solid(seeds['code-bg'], bg) ?? (dark ? away(0.18) : toward(0.035)))

  for (const key of ['destructive', 'success', 'warning']) {
    put(key, legible(seeds[key], bg, 2.5) ?? STATUS[appearance][key])
  }
  const destructive = parseColor(out.destructive)!
  put(
    'destructive-foreground',
    legible(seeds['destructive-foreground'], destructive, 3.5) ??
      bestOn(destructive, [WHITE, BLACK])
  )
  return out
}

/**
 * A line color as written, unless it draws nothing. Themes switch a border off
 * with `#00000000` (Catppuccin Latte's `input.border`), which in VS Code leaves
 * a filled input; on Carbon's outlined inputs it leaves no input at all.
 */
function visible(value: string | undefined): string | null {
  const color = parseColor(value)
  return color && color.a >= 0.05 ? value! : null
}

/** A seed as an opaque color, composited over `under` when it has alpha. */
function solid(value: string | undefined, under: Rgba | null): Rgba | null {
  const color = parseColor(value)
  if (!color) return null
  if (color.a >= 1) return color
  return under ? over(color, under) : null
}

/**
 * A seed as a surface drawn *on* `ground`: taken only if it steps visibly away
 * from it. Themes reuse the editor color freely — Dracula's
 * `button.secondaryBackground` and Nord's `editorWidget.background` are their
 * editor background exactly — and a Carbon surface equal to its ground is a
 * control with no edge (the Color-mode track, the composer). The sidebar is
 * exempt: a sidebar the color of the editor is a real design, and it has its
 * own border.
 */
function stepped(value: string | undefined, ground: Rgba): Rgba | null {
  const color = solid(value, ground)
  return color && contrast(color, ground) >= 1.06 ? color : null
}

/** A seed as text: taken only if it holds `min` contrast against its ground. */
function legible(value: string | undefined, ground: Rgba, min: number): Rgba | null {
  const color = solid(value, ground)
  return color && contrast(color, ground) >= min ? color : null
}

function bestOn(ground: Rgba, candidates: Rgba[]): Rgba {
  const good = candidates.find((candidate) => contrast(candidate, ground) >= 4.5)
  return good ?? candidates.reduce((a, b) => (contrast(a, ground) >= contrast(b, ground) ? a : b))
}

// ------------------------------------------------------------------ JSONC ---

/**
 * JSON with comments and trailing commas — what VS Code theme files are, and
 * what `JSON.parse` refuses. Strips both outside strings, then parses.
 */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  const n = text.length
  /** Index just past the string literal opening at `from`. */
  const stringEnd = (from: number): number => {
    let j = from + 1
    while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
    return j + 1
  }
  /** The next significant character after `from`, skipping whitespace and comments. */
  const nextSignificant = (from: number): string | undefined => {
    let j = from
    while (j < n) {
      if (/\s/.test(text[j])) j++
      else if (text[j] === '/' && text[j + 1] === '/') while (j < n && text[j] !== '\n') j++
      else if (text[j] === '/' && text[j + 1] === '*') {
        const end = text.indexOf('*/', j + 2)
        j = end < 0 ? n : end + 2
      } else return text[j]
    }
    return undefined
  }
  while (i < n) {
    const ch = text[i]
    if (ch === '"') {
      const end = stringEnd(i)
      out += text.slice(i, end)
      i = end
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
    } else if (ch === ',' && (nextSignificant(i + 1) === '}' || nextSignificant(i + 1) === ']')) {
      // A trailing comma — dropped here, outside strings, rather than by a
      // regex over the result that would also rewrite `"a,}"`.
      i++
    } else {
      out += ch
      i++
    }
  }
  return JSON.parse(out.replace(/^\uFEFF/, ''))
}

// ---------------------------------------------------------------- VS Code ---

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function isVsCodeTheme(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (Array.isArray(value.tokenColors) || typeof value.tokenColors === 'string') return true
  if (typeof value.include === 'string' || Array.isArray(value.semanticTokenColors)) return true
  return isRecord(value.colors) && Object.keys(value.colors).some((key) => key.includes('.'))
}

/**
 * A theme over the one it `include`s: colors merge key by key, token rules
 * append (later rules win in TextMate, so the child's sit after the base's).
 */
export function mergeVsCodeThemes(base: Json, child: Json): Json {
  const colors = { ...(isRecord(base.colors) ? base.colors : {}), ...(isRecord(child.colors) ? child.colors : {}) }
  const tokens = [
    ...(Array.isArray(base.tokenColors) ? base.tokenColors : []),
    ...(Array.isArray(child.tokenColors) ? child.tokenColors : [])
  ]
  const merged: Json = { ...base, ...child, colors, tokenColors: tokens }
  delete merged.include
  return merged
}

/** `uiTheme` in an extension manifest, or a theme file's own `type`. */
export function appearanceFromVsCode(kind: unknown): Appearance | undefined {
  if (typeof kind !== 'string') return undefined
  const k = kind.toLowerCase()
  if (k === 'vs' || k === 'light' || k === 'hc-light' || k === 'hclight') return 'light'
  if (k === 'vs-dark' || k === 'dark' || k === 'hc-black' || k === 'hc' || k === 'hcdark') {
    return 'dark'
  }
  return undefined
}

interface TokenRule {
  selectors: string[]
  foreground?: string
}

function tokenRules(tokenColors: unknown): { rules: TokenRule[]; globals: Json } {
  const rules: TokenRule[] = []
  let globals: Json = {}
  if (!Array.isArray(tokenColors)) return { rules, globals }
  for (const entry of tokenColors) {
    if (!isRecord(entry) || !isRecord(entry.settings)) continue
    const scope = entry.scope
    if (scope === undefined || scope === '') {
      globals = { ...globals, ...entry.settings }
      continue
    }
    const raw = Array.isArray(scope) ? scope : typeof scope === 'string' ? scope.split(',') : []
    const selectors = raw
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      // Descendant and exclusion selectors need a scope *stack* to mean
      // anything; matched against one scope name they would only misfire.
      .filter((s) => s && !s.includes(' ') && !s.startsWith('-'))
    const foreground = entry.settings.foreground
    if (selectors.length && typeof foreground === 'string') rules.push({ selectors, foreground })
  }
  return { rules, globals }
}

/**
 * The scopes each of Carbon's eight token groups stands for, most specific
 * first. The groups are `editorTheme.ts`' and `index.css`' — coarse on purpose —
 * so this asks "what color does this theme give a keyword", not the full
 * TextMate cascade a real tokenizer would need.
 */
const SYNTAX_SCOPES: Record<(typeof SYNTAX_VARS)[number], string[]> = {
  'syn-comment': ['comment.line', 'comment'],
  'syn-keyword': ['keyword.control', 'keyword', 'storage.type', 'storage.modifier', 'storage'],
  'syn-string': ['string.quoted', 'string'],
  'syn-number': ['constant.numeric', 'constant.language', 'constant'],
  'syn-function': ['entity.name.function', 'support.function', 'entity.name.class'],
  'syn-variable': [
    'variable.other.property',
    'support.type.property-name',
    'entity.other.attribute-name',
    'variable.other.object.property',
    'entity.name.type',
    'variable.parameter'
  ],
  'syn-builtin': [
    'support.function.builtin',
    'variable.language',
    'support.constant',
    'support.class',
    'support.type'
  ],
  'syn-meta': ['meta.preprocessor', 'meta.decorator', 'punctuation.decorator', 'markup.deleted', 'invalid']
}

function scopeColor(rules: TokenRule[], scope: string): string | undefined {
  let best: { score: number; color: string } | undefined
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (selector !== scope && !scope.startsWith(selector + '.')) continue
      // `>=` so a later rule of equal specificity wins, as it does in TextMate.
      if (!best || selector.length >= best.score) {
        best = { score: selector.length, color: rule.foreground! }
      }
    }
  }
  return best?.color
}

function syntaxVars(rules: TokenRule[], ground: Rgba): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of SYNTAX_VARS) {
    for (const scope of SYNTAX_SCOPES[key]) {
      const color = solid(scopeColor(rules, scope), ground)
      // A comment may sit quietly; a token nobody can see is a bug in the theme.
      if (color && contrast(color, ground) >= 1.8) {
        out[key] = toHex(color)
        break
      }
    }
  }
  return out
}

const pick = (colors: Json, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = colors[key]
    if (typeof value === 'string' && parseColor(value)) return value
  }
  return undefined
}

const pickLegible = (colors: Json, ground: Rgba, min: number, ...keys: string[]): string | undefined =>
  keys.map((key) => colors[key]).find(
    (value): value is string => typeof value === 'string' && legible(value, ground, min) !== null
  )

/** VS Code's own workbench colors onto Carbon's roles. */
function vsCodeTheme(json: Json, options: ImportOptions): ImportedTheme {
  const colors = isRecord(json.colors) ? json.colors : {}
  const { rules, globals } = tokenRules(json.tokenColors)
  const declared = options.appearance ?? appearanceFromVsCode(json.type)
  const bgSeed = pick(colors, 'editor.background') ?? pick(globals, 'background')
  if (!bgSeed && !declared) {
    throw new Error(
      'That VS Code theme has no "editor.background", so there is nothing to build a palette from.'
    )
  }
  const bgColor = solid(bgSeed, BLACK)
  const appearance = declared ?? (bgColor && isDark(bgColor) ? 'dark' : 'light')
  const vars = deriveVars(
    {
      background: bgSeed ? toHex(bgColor!) : undefined,
      foreground: pick(colors, 'editor.foreground', 'foreground') ?? pick(globals, 'foreground'),
      card: pick(colors, 'editorWidget.background'),
      popover: pick(colors, 'menu.background', 'quickInput.background', 'dropdown.background', 'editorWidget.background'),
      // The first candidate that also reads as text on the background: a
      // primary is a link color as often as it is a button fill.
      primary: pickLegible(
        colors,
        bgColor ?? (appearance === 'dark' ? BLACK : WHITE),
        2.5,
        'button.background',
        'focusBorder',
        'textLink.foreground',
        'activityBarBadge.background',
        'progressBar.background',
        'badge.background'
      ),
      'primary-foreground': pick(colors, 'button.foreground'),
      secondary: pick(colors, 'button.secondaryBackground'),
      'secondary-foreground': pick(colors, 'button.secondaryForeground'),
      'muted-foreground': pick(colors, 'descriptionForeground', 'editorLineNumber.activeForeground'),
      accent: pick(colors, 'list.hoverBackground'),
      border: pick(colors, 'panel.border', 'editorGroup.border', 'sideBar.border'),
      input: pick(colors, 'input.border'),
      ring: pick(colors, 'focusBorder'),
      sidebar: pick(colors, 'sideBar.background', 'activityBar.background'),
      'sidebar-foreground': pick(colors, 'sideBar.foreground'),
      'sidebar-accent': pick(colors, 'list.inactiveSelectionBackground', 'list.activeSelectionBackground', 'list.hoverBackground'),
      'sidebar-border': pick(colors, 'sideBar.border'),
      'code-bg': pick(colors, 'textCodeBlock.background', 'terminal.background', 'panel.background'),
      destructive: pick(colors, 'editorError.foreground', 'errorForeground'),
      warning: pick(colors, 'editorWarning.foreground'),
      success: pick(colors, 'gitDecoration.addedResourceForeground', 'terminal.ansiGreen')
    },
    appearance
  )
  const codeBg = parseColor(vars['code-bg'])!
  Object.assign(vars, syntaxVars(rules, parseColor(vars.background)!))
  for (const name of ANSI) {
    const cap = name[0].toUpperCase() + name.slice(1)
    const normal = solid(pick(colors, `terminal.ansi${cap}`), codeBg)
    const bright = solid(pick(colors, `terminal.ansiBright${cap}`), codeBg)
    if (normal) vars[`term-${name}`] = toHex(normal)
    if (bright) vars[`term-bright-${name}`] = toHex(bright)
  }
  return { name: options.name ?? nameOf(json, 'Imported theme'), appearance, vars }
}

// ------------------------------------------------------------------ Carbon ---

function paletteTheme(colors: Json, name: string, appearance: Appearance | undefined): ImportedTheme {
  const seeds: Seeds = {}
  const extras: Record<string, string> = {}
  for (const [rawKey, value] of Object.entries(colors)) {
    if (typeof value !== 'string' || !parseColor(value)) continue
    const key = rawKey.replace(/^--/, '')
    if (!ALL_VARS.has(key)) continue
    if ((THEME_VARS as readonly string[]).includes(key)) seeds[key] = value
    else extras[key] = value
  }
  const bg = parseColor(seeds.background)
  if (!bg) throw new Error('That theme has no background color ("background").')
  const resolved = appearance ?? (isDark(over(bg, BLACK)) ? 'dark' : 'light')
  const vars = deriveVars(seeds, resolved)
  // A palette that names a role keeps the value exactly as written: these are
  // Carbon's own variables, and an `oklch()` in an export should come back an
  // `oklch()`, not a rounded hex.
  for (const key of THEME_VARS) {
    if (seeds[key] !== undefined && vars[key] !== undefined) {
      const written = parseColor(seeds[key])!
      const derived = parseColor(vars[key])!
      if (written.a < 1 || toHex(written) === toHex(derived)) vars[key] = seeds[key]!
    }
  }
  return { name, appearance: resolved, vars: { ...vars, ...extras } }
}

function nameOf(value: Json, fallback: string): string {
  for (const key of ['name', 'label']) {
    const v = value[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return fallback
}

/**
 * Any supported theme document → one theme per appearance it defines. Throws an
 * `Error` whose message is written for the person who pasted the file.
 */
export function importThemeJson(value: unknown, options: ImportOptions = {}): ImportedTheme[] {
  if (!isRecord(value)) throw new Error('A theme is a JSON object.')
  if (isVsCodeTheme(value)) return [vsCodeTheme(value, options)]

  const name = options.name ?? nameOf(value, 'Imported theme')
  const appearance = options.appearance ?? appearanceFromVsCode(value.appearance)
  const colors: Json = isRecord(value.colors) ? value.colors : {}
  if (Object.keys(colors).length === 0) {
    throw new Error('No colors found. Expected a VS Code or Carbon theme.')
  }
  return [paletteTheme(colors, name, appearance)]
}

export function importThemeText(text: string, options: ImportOptions = {}): ImportedTheme[] {
  let value: unknown
  try {
    value = parseJsonc(text)
  } catch {
    throw new Error('That isn’t valid JSON.')
  }
  return importThemeJson(value, options)
}

/** Carbon's export format — also what `importThemeJson` reads back. */
export function exportTheme(theme: ImportedTheme): string {
  return JSON.stringify(
    { version: 1, name: theme.name, appearance: theme.appearance, colors: theme.vars },
    null,
    2
  )
}
