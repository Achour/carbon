import assert from 'node:assert/strict'
import test from 'node:test'
import { dockIconSvg } from '../src/main/dockIcon.ts'

test('runtime Dock icon uses the active theme palette', () => {
  const svg = dockIconSvg({
    background: '#112233',
    surface: '#223344',
    code: '#001122',
    foreground: '#f0f1f2',
    primary: '#aabbcc'
  })

  for (const color of ['#112233', '#223344', '#001122', '#f0f1f2', '#aabbcc']) {
    assert.match(svg, new RegExp(color, 'i'))
  }
  assert.match(svg, /M652 385 A205 205/)
  assert.match(svg, /rx="184"/)
})

test('runtime Dock icon rejects non-hex color input', () => {
  const svg = dockIconSvg({
    background: '"><script>alert(1)</script>',
    surface: 'red',
    code: 'transparent',
    foreground: 'currentColor',
    primary: 'url(evil)'
  })

  assert.doesNotMatch(svg, /script|url\(evil\)|currentColor/)
  assert.match(svg, /#1c1c1c/)
  assert.match(svg, /#e4e4e4/)
})
