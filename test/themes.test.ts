import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_THEME,
  DEFAULT_THEME_MODE,
  resolveAppearance,
  THEMES
} from '../src/renderer/src/lib/themes.ts'

const REQUIRED_VARS = [
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
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'sidebar',
  'sidebar-foreground',
  'sidebar-accent',
  'sidebar-border',
  'code-bg',
  'success',
  'warning'
] as const

const MODES = (theme: (typeof THEMES)[number]) =>
  [
    ['dark', theme.vars],
    ['light', theme.lightVars]
  ] as const

/** OKLCH lightness, for the ordering invariants. Alpha forms are not parsed. */
function lightness(css: string): number {
  const match = /^oklch\(([\d.]+) /.exec(css)
  assert.ok(match, `expected a plain oklch() value, got ${css}`)
  return Number(match[1])
}

/**
 * WCAG relative luminance for an `oklch()` string: OKLab → linear sRGB → Y.
 * Inlined rather than pulled from a color library so `node --test` can run this
 * file directly, per the project's dependency-free test rule.
 */
function luminance(css: string): number {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)/.exec(css)
  assert.ok(match, `expected a plain oklch() value, got ${css}`)
  const [lightnessValue, chroma, hue] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3])
  ]
  const a = chroma * Math.cos((hue * Math.PI) / 180)
  const b = chroma * Math.sin((hue * Math.PI) / 180)
  const long = (lightnessValue + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const medium = (lightnessValue - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const short = (lightnessValue - 0.0894841775 * a - 1.291485548 * b) ** 3
  const [red, green, blue] = [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short
  ].map((channel) => Math.min(1, Math.max(0, channel)))
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a
  )
  return (high + 0.05) / (low + 0.05)
}

test('ships the six curated themes with Carbon as the default', () => {
  assert.equal(DEFAULT_THEME, 'carbon')
  assert.equal(DEFAULT_THEME_MODE, 'dark')
  assert.equal(THEMES.length, 6)
  assert.equal(THEMES[0].id, 'carbon')
  assert.equal(new Set(THEMES.map((theme) => theme.id)).size, THEMES.length)
  assert.equal(new Set(THEMES.map((theme) => theme.name)).size, THEMES.length)
})

test('explicit modes win while System resolves the device appearance', () => {
  assert.equal(resolveAppearance('dark', false), 'dark')
  assert.equal(resolveAppearance('light', true), 'light')
  assert.equal(resolveAppearance('system', true), 'dark')
  assert.equal(resolveAppearance('system', false), 'light')
})

test('every theme provides the complete renderer color contract in both modes', () => {
  for (const theme of THEMES) {
    for (const [mode, vars] of MODES(theme)) {
      for (const variable of REQUIRED_VARS) {
        assert.ok(vars[variable], `${theme.name} ${mode} is missing --${variable}`)
      }
    }
    assert.notDeepEqual(theme.vars, theme.lightVars, `${theme.name} modes should differ`)
  }
})

/**
 * The regression that motivated trimming the registry: the old light modes were
 * all derived from one accent-into-near-white helper, so 22 of 28 themes shared
 * a light palette and differed only in button color. Both modes are asserted
 * distinct pairwise — a derived light mode would collapse this immediately.
 */
test('no two themes share a palette, in either mode', () => {
  for (const mode of ['dark', 'light'] as const) {
    const signatures = new Map<string, string>()
    for (const theme of THEMES) {
      const vars = mode === 'dark' ? theme.vars : theme.lightVars
      const signature = [
        vars.background,
        vars.card,
        vars.primary,
        vars.accent,
        vars.sidebar,
        vars['code-bg']
      ].join('|')
      const clash = signatures.get(signature)
      assert.equal(clash, undefined, `${theme.id} and ${clash} share a ${mode} palette`)
      signatures.set(signature, theme.id)
    }
  }
})

/**
 * Carbon is the default and predates the rewrite; its dark mode must survive it
 * byte for byte. The generator reproduces this literal rather than special-casing
 * Carbon, so this is what proves the two are equivalent.
 */
test('Carbon dark is unchanged by the rewrite', () => {
  assert.deepEqual(THEMES[0].vars, {
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
  })
})

/**
 * `accent` is the hover level. It has to sit a step *away* from the surfaces it
 * covers — lighter in dark mode, darker in light — or hovering a menu item
 * repaints the color already there and reads as nothing happening.
 */
test('hover sits clear of the surfaces it covers, in both directions', () => {
  for (const theme of THEMES) {
    for (const [mode, vars] of MODES(theme)) {
      const hover = lightness(vars.accent)
      for (const surface of ['popover', 'secondary', 'card'] as const) {
        const level = lightness(vars[surface])
        const gap = mode === 'dark' ? hover - level : level - hover
        assert.ok(
          gap > 0.003,
          `${theme.name} ${mode}: hover (${hover}) is not clear of ${surface} (${level})`
        )
      }
    }
  }
})

/**
 * `primary` is both text on the background and the fill under `primary-foreground`
 * on buttons, so it is checked in both roles — passing one says nothing about
 * the other, and the button role is the one that silently fails.
 */
test('every theme meets its contrast targets in both modes', () => {
  const pairs: [string, string, number][] = [
    ['foreground', 'background', 7],
    ['card-foreground', 'card', 7],
    ['popover-foreground', 'popover', 7],
    ['sidebar-foreground', 'sidebar', 7],
    ['muted-foreground', 'background', 4.5],
    ['muted-foreground', 'card', 4.5],
    ['primary', 'background', 4.5],
    ['primary', 'card', 4.5],
    ['primary-foreground', 'primary', 4.5]
  ]
  for (const theme of THEMES) {
    for (const [mode, vars] of MODES(theme)) {
      for (const [foreground, background, minimum] of pairs) {
        const ratio = contrast(vars[foreground], vars[background])
        assert.ok(
          ratio >= minimum,
          `${theme.name} ${mode}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, want ${minimum}:1`
        )
      }
    }
  }
})
