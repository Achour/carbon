import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import {
  contrast,
  exportTheme,
  importThemeJson,
  importThemeText,
  mergeVsCodeThemes,
  parseColor,
  parseJsonc,
  THEME_VARS
} from '../src/shared/themeImport.ts'
import { openZip } from '../src/main/zip.ts'
import { THEMES } from '../src/renderer/src/lib/themes.ts'

const DRACULA = {
  name: 'Dracula',
  type: 'dark',
  colors: {
    'editor.background': '#282A36',
    'editor.foreground': '#F8F8F2',
    'sideBar.background': '#21222C',
    'button.background': '#44475A',
    'focusBorder': '#6272A4',
    'list.hoverBackground': '#44475A75',
    'terminal.ansiRed': '#FF5555',
    'terminal.ansiBrightGreen': '#69FF94'
  },
  tokenColors: [
    { settings: { background: '#282A36', foreground: '#F8F8F2' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#6272A4' } },
    { scope: 'string', settings: { foreground: '#F1FA8C' } },
    { scope: 'keyword, storage.type', settings: { foreground: '#FF79C6' } },
    { scope: 'meta.embedded keyword', settings: { foreground: '#000000' } }
  ]
}

test('the import contract matches the built-in themes’ variables exactly', () => {
  assert.deepEqual([...THEME_VARS].sort(), Object.keys(THEMES[0].vars).sort())
})

test('a VS Code theme fills every variable with a parseable color', () => {
  const [theme] = importThemeJson(DRACULA)
  assert.equal(theme.name, 'Dracula')
  assert.equal(theme.appearance, 'dark')
  for (const key of THEME_VARS) {
    assert.ok(parseColor(theme.vars[key]), `${key} = ${theme.vars[key]}`)
  }
  assert.equal(theme.vars.background, '#282a36')
  assert.equal(theme.vars.sidebar, '#21222c')
})

test('a surface that equals its ground is derived instead, so controls keep an edge', () => {
  const [theme] = importThemeJson({
    ...DRACULA,
    colors: { ...DRACULA.colors, 'button.secondaryBackground': '#282A36', 'editorWidget.background': '#282A36' }
  })
  const bg = parseColor(theme.vars.background)!
  assert.ok(contrast(parseColor(theme.vars.secondary)!, bg) >= 1.06)
  assert.ok(contrast(parseColor(theme.vars.card)!, bg) >= 1.06)
})

test('a border switched off with full transparency is derived instead', () => {
  const [theme] = importThemeJson({
    ...DRACULA,
    colors: { ...DRACULA.colors, 'input.border': '#00000000', 'panel.border': '#bd93f9' }
  })
  assert.ok(parseColor(theme.vars.input)!.a >= 0.05)
  assert.equal(theme.vars.border, '#bd93f9')
})

test('a theme’s accent is skipped when it would be unreadable as text', () => {
  // #44475A on #282A36 is ~1.6:1 — fine as a button, invisible as a link.
  const [theme] = importThemeJson(DRACULA)
  assert.equal(theme.vars.primary, '#6272a4')
  const fill = parseColor(theme.vars.primary)!
  assert.ok(contrast(fill, parseColor(theme.vars['primary-foreground'])!) >= 4.5)
})

test('token colors map onto the syntax groups; descendant selectors are ignored', () => {
  const [theme] = importThemeJson(DRACULA)
  assert.equal(theme.vars['syn-comment'], '#6272a4')
  assert.equal(theme.vars['syn-string'], '#f1fa8c')
  assert.equal(theme.vars['syn-keyword'], '#ff79c6')
})

test('terminal ANSI colors are carried over when the theme has them', () => {
  const [theme] = importThemeJson(DRACULA)
  assert.equal(theme.vars['term-red'], '#ff5555')
  assert.equal(theme.vars['term-bright-green'], '#69ff94')
  assert.equal(theme.vars['term-blue'], undefined)
})

test('translucent workbench colors are composited, not passed through', () => {
  const [theme] = importThemeJson(DRACULA)
  assert.match(theme.vars.accent, /^#[0-9a-f]{6}$/)
})

test('appearance comes from the manifest, then `type`, then the background', () => {
  const light = { colors: { 'editor.background': '#fafafa', 'editor.foreground': '#333333' }, tokenColors: [] }
  assert.equal(importThemeJson(light)[0].appearance, 'light')
  assert.equal(importThemeJson({ ...light, type: 'dark' })[0].appearance, 'dark')
  assert.equal(importThemeJson(light, { appearance: 'dark' })[0].appearance, 'dark')
})

test('a theme without a background or a declared appearance is refused with a reason', () => {
  assert.throws(() => importThemeJson({ colors: { 'button.background': '#fff' } }), /editor\.background/)
})

test('JSONC: comments and trailing commas, but not inside strings', () => {
  const text = `{
    // a comment
    "name": "A // not a comment",
    /* block */ "colors": { "editor.background": "#101010", },
    "tokenColors": [],
  }`
  assert.deepEqual(parseJsonc(text), {
    name: 'A // not a comment',
    colors: { 'editor.background': '#101010' },
    tokenColors: []
  })
})

test('JSONC: a comma-and-brace inside a string survives', () => {
  assert.deepEqual(parseJsonc('{ "name": "a,}", "list": ["x, ]", ], }'), { name: 'a,}', list: ['x, ]'] })
})

test('a color function carrying CSS after it is not a color', () => {
  assert.equal(parseColor('rgba(0,0,0,.5)} body{display:none} :root{--x:rgb(1,2,3)'), null)
  assert.ok(parseColor('rgba(0, 0, 0, 0.5)'))
  assert.ok(parseColor('oklch(0.62 0.19 27 / 40%)'))
})

test('include merges colors key by key and appends token rules', () => {
  const merged = mergeVsCodeThemes(
    { colors: { a: '#111', b: '#222' }, tokenColors: [{ scope: 'x', settings: {} }] },
    { include: './base.json', colors: { b: '#333' }, tokenColors: [{ scope: 'y', settings: {} }] }
  )
  assert.deepEqual(merged.colors, { a: '#111', b: '#333' })
  assert.equal((merged.tokenColors as unknown[]).length, 2)
  assert.equal(merged.include, undefined)
})

test('T3 Code short form: canvas and accent generate the rest', () => {
  const [theme] = importThemeJson({
    name: 'Nightfall',
    appearance: 'dark',
    canvas: '#1a1b26',
    accent: '#7aa2f7',
    colors: { terminalSelection: '#292e42', error: '#f7768e' }
  })
  assert.equal(theme.name, 'Nightfall')
  assert.equal(theme.vars.background, '#1a1b26')
  assert.equal(theme.vars.primary, '#7aa2f7')
  assert.equal(theme.vars.destructive, '#f7768e')
  for (const key of THEME_VARS) assert.ok(parseColor(theme.vars[key]), key)
})

test('T3 Code variants become one theme per appearance', () => {
  const themes = importThemeJson({
    label: 'Grove',
    variants: { dark: { canvas: '#14201a', text: '#e0eee6' }, light: { canvas: '#f6faf7' } }
  })
  assert.deepEqual(
    themes.map((t) => [t.name, t.appearance]),
    [
      ['Grove Dark', 'dark'],
      ['Grove Light', 'light']
    ]
  )
})

test('Carbon’s own export round-trips, oklch() values kept as written', () => {
  const carbon = THEMES.find((t) => t.id === 'tide')!
  const text = exportTheme({ name: 'Tide copy', appearance: 'dark', vars: carbon.vars })
  const [back] = importThemeText(text)
  assert.equal(back.name, 'Tide copy')
  assert.equal(back.appearance, 'dark')
  assert.equal(back.vars.background, carbon.vars.background)
  assert.equal(back.vars.primary, carbon.vars.primary)
  assert.equal(back.vars.border, carbon.vars.border)
})

test('oklch() parses to the sRGB it names', () => {
  assert.deepEqual(parseColor('oklch(1 0 0)'), { r: 255, g: 255, b: 255, a: 1 })
  assert.deepEqual(parseColor('oklch(0 0 0 / 50%)'), { r: 0, g: 0, b: 0, a: 0.5 })
  assert.equal(parseColor('#12345'), null)
  assert.equal(parseColor('red'), null)
})

test('invalid JSON reads as a sentence, not a stack trace', () => {
  assert.throws(() => importThemeText('{ nope'), /valid JSON/)
})

/** A zip built the way vsce writes one: data-descriptor flag set, local sizes zeroed. */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text)
    const data = deflateRawSync(raw)
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(1 << 3, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

test('zip: reads deflated entries by the central directory’s sizes, on demand', () => {
  const zip = zipOf({
    'extension/package.json': '{"name":"x"}',
    'extension/themes/a.json': '{"colors":{}}',
    'extension/icon.png': 'png'
  })
  const archive = openZip(zip)
  assert.deepEqual(archive.names, ['extension/package.json', 'extension/themes/a.json', 'extension/icon.png'])
  assert.equal(archive.read('extension/package.json')!.toString(), '{"name":"x"}')
  assert.equal(archive.read('extension/missing.json'), undefined)
})

test('zip: an entry past the cap is not inflated, whatever size it declares', () => {
  const zip = zipOf({ 'extension/big.json': 'x'.repeat(5000) })
  assert.equal(openZip(zip, 1000).read('extension/big.json'), undefined)
  assert.equal(openZip(zip).read('extension/big.json')!.length, 5000)
})

test('zip: something that is not one is refused', () => {
  assert.throws(() => openZip(Buffer.from('not a zip at all, just text here')), /zip/)
})
