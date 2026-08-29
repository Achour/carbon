import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isMermaidFence,
  languageFromFenceInfo,
  pathFromFenceInfo,
  remarkHighlightLang
} from '../src/renderer/src/lib/highlight.ts'

test('extracts a startLine:endLine:filepath citation', () => {
  assert.equal(
    pathFromFenceInfo('896:905:src/renderer/src/components/Composer.tsx'),
    'src/renderer/src/components/Composer.tsx'
  )
  assert.equal(pathFromFenceInfo('1:20:/abs/path/foo.ts'), '/abs/path/foo.ts')
  assert.equal(pathFromFenceInfo('12:34:C:\\Users\\app\\main.rs'), 'C:\\Users\\app\\main.rs')
})

test('extracts a bare path and a basename with an extension', () => {
  assert.equal(pathFromFenceInfo('src/foo.ts'), 'src/foo.ts')
  assert.equal(pathFromFenceInfo('Composer.tsx'), 'Composer.tsx')
  assert.equal(pathFromFenceInfo('./lib/highlight.ts'), './lib/highlight.ts')
})

test('does not treat a language tag as a path', () => {
  assert.equal(pathFromFenceInfo('tsx'), undefined)
  assert.equal(pathFromFenceInfo('ts'), undefined)
  assert.equal(pathFromFenceInfo('json'), undefined)
  assert.equal(pathFromFenceInfo('mermaid'), undefined)
  assert.equal(pathFromFenceInfo('bash'), undefined)
  assert.equal(pathFromFenceInfo('dockerfile'), undefined)
  assert.equal(pathFromFenceInfo(''), undefined)
  assert.equal(pathFromFenceInfo('  '), undefined)
})

test('maps a citation onto a highlight.js language', () => {
  assert.equal(languageFromFenceInfo('tsx'), 'tsx')
  assert.equal(languageFromFenceInfo('ts'), 'ts')
  assert.equal(languageFromFenceInfo('bash'), 'bash')
  assert.equal(
    languageFromFenceInfo('896:905:src/renderer/src/components/Composer.tsx'),
    'typescript'
  )
  assert.equal(languageFromFenceInfo('src/main.py'), 'python')
  assert.equal(languageFromFenceInfo('script.sh'), 'bash')
})

test('leaves mermaid and unknown tags alone', () => {
  assert.equal(languageFromFenceInfo('mermaid'), undefined)
  assert.equal(languageFromFenceInfo('not-a-language'), undefined)
  assert.equal(languageFromFenceInfo('1:2:unknown.xyz'), undefined)
  assert.equal(languageFromFenceInfo(''), undefined)
  assert.equal(languageFromFenceInfo(null), undefined)
})

test('remark plugin remaps citation fences and keeps mermaid', () => {
  const tree = {
    type: 'root',
    children: [
      {
        type: 'code',
        lang: '896:905:src/renderer/src/components/Composer.tsx',
        value: 'const submit = (): void => {}'
      },
      { type: 'code', lang: 'mermaid', value: 'graph TD; A-->B' },
      { type: 'code', lang: 'tsx', value: 'export const n = 1' },
      {
        type: 'blockquote',
        children: [{ type: 'code', lang: '12:14:app.py', value: 'print(1)' }]
      }
    ]
  }
  remarkHighlightLang()(tree)
  assert.equal(tree.children[0].lang, 'typescript')
  assert.equal(tree.children[1].lang, 'mermaid')
  assert.equal(tree.children[2].lang, 'tsx')
  assert.equal(tree.children[3].children[0].lang, 'python')
})

test('a language tag carrying meta still resolves', () => {
  // mdast hands remark only the first word, so the streaming path — which sees
  // the info string whole — has to agree with it or the same block is
  // highlighted on one side of the fence's close and plain on the other.
  assert.equal(languageFromFenceInfo('ts title=foo.ts'), 'ts')
  assert.equal(languageFromFenceInfo('bash {1,3}'), 'bash')
})

test('a citation with spaces in the path beats the first-word split', () => {
  assert.equal(languageFromFenceInfo('896:905:src/my file.ts'), 'typescript')
})

test('meta that is not a language still resolves to nothing', () => {
  assert.equal(languageFromFenceInfo('nonsense tag'), undefined)
})

test('isMermaidFence reads the tag, not the whole info string', () => {
  assert.equal(isMermaidFence('mermaid'), true)
  assert.equal(isMermaidFence('mermaid theme=dark'), true)
  assert.equal(isMermaidFence('ts'), false)
  assert.equal(isMermaidFence(undefined), false)
})
