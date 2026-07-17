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
