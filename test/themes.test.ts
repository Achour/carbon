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

test('ships Carbon plus the complete Codex-inspired theme set', () => {
  assert.equal(DEFAULT_THEME, 'carbon')
  assert.equal(DEFAULT_THEME_MODE, 'dark')
  assert.equal(THEMES.length, 28)
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
    for (const [mode, vars] of [
      ['dark', theme.vars],
      ['light', theme.lightVars]
    ] as const) {
      for (const variable of REQUIRED_VARS) {
        assert.ok(vars[variable], `${theme.name} ${mode} is missing --${variable}`)
      }
    }
    assert.notDeepEqual(theme.vars, theme.lightVars, `${theme.name} modes should differ`)
  }
})

test('theme palettes stay visually distinct instead of only renaming the same colors', () => {
  const signatureKeys = ['background', 'card', 'sidebar', 'code-bg', 'primary'] as const

  for (const [mode, palettes] of [
    ['dark', THEMES.map((theme) => theme.vars)],
    ['light', THEMES.map((theme) => theme.lightVars)]
  ] as const) {
    const signatures = palettes.map((vars) =>
      signatureKeys.map((key) => vars[key]).join('|')
    )
    assert.equal(
      new Set(signatures).size,
      THEMES.length,
      `${mode} themes must have unique surface and accent signatures`
    )
  }

  const rgb = (hex: string): [number, number, number] => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ]
  const distance = (left: string, right: string): number => {
    const a = rgb(left)
    const b = rgb(right)
    return Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0))
  }

  // Carbon uses OKLCH; every Codex-inspired dark palette uses concrete hex
  // colors so we can catch future near-copy/paste regressions numerically.
  const themed = THEMES.slice(1)
  for (let left = 0; left < themed.length; left += 1) {
    for (let right = left + 1; right < themed.length; right += 1) {
      const a = themed[left]
      const b = themed[right]
      const averageDistance =
        signatureKeys.reduce(
          (sum, key) => sum + distance(a.vars[key], b.vars[key]),
          0
        ) / signatureKeys.length
      assert.ok(
        averageDistance >= 15,
        `${a.name} and ${b.name} are too visually similar (${averageDistance.toFixed(1)})`
      )
    }
  }
})
