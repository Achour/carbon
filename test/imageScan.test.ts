import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickTurnImages, shellTokens } from '../src/main/imageScan.ts'
import type { ImageStat, PickTurnImagesDeps } from '../src/main/imageScan.ts'

// A virtual filesystem: absolute path -> {mtime, real}. `real` defaults to the
// path itself (distinct files have distinct real paths, like a real `cp` copy).
const CWD = '/proj'
const HOME = '/home/u'
const GEN = '/home/u/.codex/generated_images'
const TURN = 10_000
const STALE = 5_000 // older than TURN-2000 (a pre-existing / merely-read file)
const FRESH = 12_000 // written this turn

function fs(files: Record<string, { mtime: number; real?: string }>): PickTurnImagesDeps['stat'] {
  return (abs: string): ImageStat | null => {
    const f = files[abs]
    return f ? { isFile: true, mtimeMs: f.mtime, real: f.real ?? abs } : null
  }
}

function pick(
  input: Partial<Parameters<typeof pickTurnImages>[0]>,
  stat: PickTurnImagesDeps['stat']
): string[] {
  return pickTurnImages(
    { text: '', commands: [], changes: [], generated: [], ...input },
    { cwd: CWD, home: HOME, genDir: GEN, turnStart: TURN, stat }
  )
}

test('shellTokens: quotes and escaped spaces stay one token', () => {
  assert.deepEqual(shellTokens('cp -p "/tmp/a b.png" out.png'), [
    'cp',
    '-p',
    '/tmp/a b.png',
    'out.png'
  ])
  assert.deepEqual(shellTokens("mv 'my logo.png' dest.png"), ['mv', 'my logo.png', 'dest.png'])
  assert.deepEqual(shellTokens('cp gen.png assets/My\\ Logo.png'), [
    'cp',
    'gen.png',
    'assets/My Logo.png'
  ])
})

test('absolute path without spaces, cp source+dest → project shown once', () => {
  const src = `${GEN}/t/img_0.png`
  const out = pick(
    { commands: [`cp ${src} /proj/logo.png`] },
    fs({ [src]: { mtime: FRESH }, '/proj/logo.png': { mtime: FRESH } })
  )
  assert.deepEqual(out, ['/proj/logo.png']) // project preferred, raw source dropped
})

test('relative project path via structured file_change (trusted, no mtime check)', () => {
  const out = pick({ changes: ['assets/pic.png'] }, fs({ '/proj/assets/pic.png': { mtime: STALE } }))
  assert.deepEqual(out, ['/proj/assets/pic.png'])
})

test('quoted absolute path containing spaces (cp -p, preserved old mtime)', () => {
  const src = `${GEN}/t/a b.png`
  const out = pick(
    { commands: [`cp -p "${src}" "/proj/my logo.png"`] },
    fs({ [src]: { mtime: STALE }, '/proj/my logo.png': { mtime: STALE } })
  )
  assert.deepEqual(out, ['/proj/my logo.png']) // trusted dest wins despite stale mtime
})

test('relative path containing spaces (quoted cp destination)', () => {
  const out = pick(
    { commands: ['cp gen.png "assets/My Logo.png"'] },
    fs({ '/proj/gen.png': { mtime: FRESH }, '/proj/assets/My Logo.png': { mtime: STALE } })
  )
  assert.deepEqual(out, ['/proj/assets/My Logo.png'])
})

test('markdown destination encoded with %20 is not double-surfaced', () => {
  // The Markdown renderer already shows a `](path)` link; the scanner must skip it.
  const out = pick(
    {
      text: 'Saved to [logo](assets/My%20Logo.png)',
      commands: ['convert in.png "assets/My Logo.png"']
    },
    fs({ '/proj/in.png': { mtime: FRESH }, '/proj/assets/My Logo.png': { mtime: FRESH } })
  )
  assert.deepEqual(out, []) // already rendered inline by the markdown link
})

test('markdown angle-bracket destination with spaces is not double-surfaced', () => {
  const out = pick(
    { text: 'Here: [logo](<assets/My Logo.png>)', changes: ['assets/My Logo.png'] },
    fs({ '/proj/assets/My Logo.png': { mtime: FRESH } })
  )
  assert.deepEqual(out, [])
})

test('cp -p destination with older preserved mtime is surfaced', () => {
  const out = pick(
    { commands: ['cp -p /tmp/raw.png /proj/final.png'] },
    fs({ '/tmp/raw.png': { mtime: STALE }, '/proj/final.png': { mtime: STALE } })
  )
  assert.deepEqual(out, ['/proj/final.png'])
})

test('a merely-read image (stale mtime, prose mention, untrusted) is NOT surfaced', () => {
  const out = pick(
    { text: 'I inspected /proj/existing.png for reference.' },
    fs({ '/proj/existing.png': { mtime: STALE } })
  )
  assert.deepEqual(out, [])
})

test('same file mentioned in a command and prose is surfaced once', () => {
  const out = pick(
    {
      text: 'Wrote /proj/out.png',
      commands: ['sips -s format png in.jpg --out /proj/out.png']
    },
    fs({ '/proj/out.png': { mtime: FRESH } })
  )
  assert.deepEqual(out, ['/proj/out.png'])
})

test('source/destination copies dedupe by real path', () => {
  // Two references resolving to the same real file → one entry.
  const out = pick(
    { changes: ['a.png'], text: 'see ./a.png' },
    fs({ '/proj/a.png': { mtime: FRESH, real: '/proj/a.png' } })
  )
  assert.deepEqual(out, ['/proj/a.png'])
})

test('prefers project deliverables over raw generated sources', () => {
  const raw = `${GEN}/t/img_0.png`
  const out = pick(
    { changes: ['deliver.png'], commands: [`cat ${raw}`] },
    fs({ '/proj/deliver.png': { mtime: FRESH }, [raw]: { mtime: FRESH } })
  )
  assert.deepEqual(out, ['/proj/deliver.png'])
})

test('falls back to the raw generated source when no project copy exists', () => {
  const raw = `${GEN}/t/only.png`
  const out = pick({ changes: [raw] }, fs({ [raw]: { mtime: FRESH } }))
  assert.deepEqual(out, [raw])
})

test('built-in image_gen with an empty final response surfaces its fresh thread file', () => {
  const raw = `${GEN}/thread-id/exec-generated.png`
  const out = pick({ generated: [raw] }, fs({ [raw]: { mtime: FRESH } }))
  assert.deepEqual(out, [raw])
})

test('an old generated file from a previous turn is not surfaced again', () => {
  const raw = `${GEN}/thread-id/previous.png`
  const out = pick({ generated: [raw] }, fs({ [raw]: { mtime: STALE } }))
  assert.deepEqual(out, [])
})

test('project copy still wins over a directly discovered generated image', () => {
  const raw = `${GEN}/thread-id/exec-generated.png`
  const out = pick(
    { generated: [raw], commands: [`cp ${raw} assets/notebook.png`] },
    fs({ [raw]: { mtime: FRESH }, '/proj/assets/notebook.png': { mtime: FRESH } })
  )
  assert.deepEqual(out, ['/proj/assets/notebook.png'])
})

test('caps the number of surfaced images at 4', () => {
  const files: Record<string, { mtime: number }> = {}
  const changes: string[] = []
  for (let i = 0; i < 7; i++) {
    changes.push(`img${i}.png`)
    files[`/proj/img${i}.png`] = { mtime: FRESH }
  }
  const out = pick({ changes }, fs(files))
  assert.equal(out.length, 4)
})

test('no image references → empty', () => {
  assert.deepEqual(pick({ text: 'just some prose, no pictures' }, fs({})), [])
})

test('structured intermediate copied to final project output surfaces only the final', () => {
  const out = pick(
    {
      changes: ['tmp/intermediate.png'],
      commands: ['cp tmp/intermediate.png assets/final.png']
    },
    fs({
      '/proj/tmp/intermediate.png': { mtime: FRESH },
      '/proj/assets/final.png': { mtime: FRESH }
    })
  )
  assert.deepEqual(out, ['/proj/assets/final.png'])
})

test('multi-step chain (generate → convert → copy) surfaces only the terminal output', () => {
  const gen = `${GEN}/t/raw.png`
  const out = pick(
    {
      changes: [gen, 'work/mid.png'],
      commands: [`convert ${gen} work/mid.png`, 'cp work/mid.png assets/final.png']
    },
    fs({
      [gen]: { mtime: FRESH },
      '/proj/work/mid.png': { mtime: FRESH },
      '/proj/assets/final.png': { mtime: FRESH }
    })
  )
  assert.deepEqual(out, ['/proj/assets/final.png'])
})

test('multiple independent finals still return up to four', () => {
  const out = pick(
    {
      commands: [
        'cp a.src.png one.png',
        'cp b.src.png two.png',
        'cp c.src.png three.png',
        'cp d.src.png four.png'
      ]
    },
    fs({
      '/proj/a.src.png': { mtime: FRESH },
      '/proj/b.src.png': { mtime: FRESH },
      '/proj/c.src.png': { mtime: FRESH },
      '/proj/d.src.png': { mtime: FRESH },
      '/proj/one.png': { mtime: FRESH },
      '/proj/two.png': { mtime: FRESH },
      '/proj/three.png': { mtime: FRESH },
      '/proj/four.png': { mtime: FRESH }
    })
  )
  assert.deepEqual(out.sort(), ['/proj/four.png', '/proj/one.png', '/proj/three.png', '/proj/two.png'])
})

test('copying a project deliverable to a raw backup keeps the project file', () => {
  // Reverse direction: project → generated_images. The deliverable must survive.
  const backup = `${GEN}/t/backup.png`
  const out = pick(
    { changes: ['assets/logo.png'], commands: [`cp assets/logo.png ${backup}`] },
    fs({ '/proj/assets/logo.png': { mtime: FRESH }, [backup]: { mtime: FRESH } })
  )
  assert.deepEqual(out, ['/proj/assets/logo.png'])
})

test('~ home expansion resolves', () => {
  const out = pick(
    { changes: ['~/Pictures/shot.png'] },
    fs({ '/home/u/Pictures/shot.png': { mtime: FRESH } })
  )
  assert.deepEqual(out, ['/home/u/Pictures/shot.png'])
})
