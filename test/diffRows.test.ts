import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countRows,
  diffItems,
  expandStep,
  foldRanges,
  mergeRanges,
  parseDiff,
  rowRangesForLines,
  type DiffRow
} from '../src/renderer/src/lib/diffRows.ts'

const COMPACT = [
  'diff --git a/a.ts b/a.ts',
  'index 111..222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  '+two.5',
  ' three',
  '@@ -20,2 +21,2 @@',
  ' twenty',
  '-old',
  '+new',
  ''
].join('\n')

test('parses rows and numbers both sides', () => {
  const { rows } = parseDiff(COMPACT)
  assert.deepEqual(
    rows.map((r) => [r.kind, r.old, r.new, r.text]),
    [
      ['ctx', 1, 1, 'one'],
      ['del', 2, null, 'two'],
      ['add', null, 2, 'TWO'],
      ['add', null, 3, 'two.5'],
      ['ctx', 3, 4, 'three'],
      ['ctx', 20, 21, 'twenty'],
      ['del', 21, null, 'old'],
      ['add', null, 22, 'new']
    ]
  )
})

test('records what git elided as new-file lines, keyed by the row it precedes', () => {
  const { gaps } = parseDiff(COMPACT)
  // Between "three" (new line 4) and "twenty" (new line 21): lines 5..20.
  assert.deepEqual(gaps, { 5: [5, 20] })
})

test('a hunk starting at line 1 elides nothing', () => {
  const { gaps } = parseDiff(['@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n'))
  assert.deepEqual(gaps, {})
})

test('a leading gap is measured off the header, not the first row', () => {
  // The hunk opens on a deletion, which carries no new-file line number — so
  // reading the gap off the first row would read `null`.
  const { gaps } = parseDiff(['@@ -20,2 +20,1 @@', '-gone', ' kept', ''].join('\n'))
  assert.deepEqual(gaps, { 0: [1, 19] })
})

test('a body line beginning with --- is content, not a file header', () => {
  // The `-` marks a deletion whose text is `-- comment`; reading it as the
  // diff's `--- a/file` header would drop it and desync every line after.
  const { rows } = parseDiff(['@@ -1,2 +1,1 @@', '--- comment', ' kept', ''].join('\n'))
  assert.deepEqual(
    rows.map((r) => [r.kind, r.text]),
    [
      ['del', '-- comment'],
      ['ctx', 'kept']
    ]
  )
})

const ctxRows = (n: number, from = 1): DiffRow[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'ctx' as const,
    old: from + i,
    new: from + i,
    text: `l${from + i}`
  }))

const change: DiffRow = { kind: 'add', old: null, new: 0, text: 'changed' }

test('folds context beyond the window on both sides of a change', () => {
  const rows = [...ctxRows(20), change, ...ctxRows(20, 21)]
  // Keep 3 either side of index 20 → hide 0..16 and 24..40.
  assert.deepEqual(foldRanges(rows), [
    [0, 17],
    [24, 41]
  ])
})

test('a run too short to be worth folding is left alone', () => {
  const rows = [change, ...ctxRows(9), change]
  // 9 context rows, 3 kept either side → a 3-row gap, below MIN_FOLD of 4.
  assert.deepEqual(foldRanges(rows), [])
})

test('revealed rows are subtracted, and can split one fold in two', () => {
  const rows = [change, ...ctxRows(40)]
  assert.deepEqual(foldRanges(rows), [[4, 41]])
  assert.deepEqual(foldRanges(rows, [[10, 20]]), [
    [4, 10],
    [20, 41]
  ])
})

test('mergeRanges collapses overlapping and touching line spans', () => {
  assert.deepEqual(
    mergeRanges([
      [10, 20],
      [5, 12],
      [21, 30],
      [50, 60]
    ]),
    [
      [5, 30],
      [50, 60]
    ]
  )
})

test('line spans map onto the rows carrying them', () => {
  const rows = [change, ...ctxRows(40)]
  // ctxRows start at new line 1 and sit at row index 1 onward.
  assert.deepEqual(rowRangesForLines(rows, [[5, 9]]), [[5, 10]])
})

test('a deletion inside a span splits it, which folding does not care about', () => {
  const del: DiffRow = { kind: 'del', old: 5, new: null, text: 'gone' }
  const rows = [...ctxRows(4), del, ...ctxRows(4, 5)]
  assert.deepEqual(rowRangesForLines(rows, [[1, 8]]), [
    [0, 4],
    [5, 9]
  ])
})

test('items carry git gaps by the lines they hide', () => {
  const items = diffItems(parseDiff(COMPACT), { full: false })
  assert.deepEqual(
    items.find((i) => i.kind === 'gap'),
    { kind: 'gap', count: 16, lines: [5, 20] }
  )
})

test('items carry our own folds the same way', () => {
  const rows = [change, ...ctxRows(40)]
  const items = diffItems({ rows, gaps: {} }, { full: true })
  assert.deepEqual(
    items.filter((i) => i.kind === 'gap'),
    [{ kind: 'gap', count: 37, lines: [4, 40] }]
  )
  // Folded rows are not emitted: 4 rows drawn, not 41.
  assert.equal(items.filter((i) => i.kind === 'row').length, 4)
})

test('revealing lines opens the fold that hid them', () => {
  const rows = [change, ...ctxRows(40)]
  const items = diffItems({ rows, gaps: {} }, { full: true, revealed: [[4, 23]] })
  assert.deepEqual(
    items.filter((i) => i.kind === 'gap'),
    [{ kind: 'gap', count: 17, lines: [24, 40] }]
  )
})

test('the first changed row of each run is a hunk anchor', () => {
  const items = diffItems(parseDiff(COMPACT), { full: false })
  const anchors = items.flatMap((i) => (i.kind === 'row' && i.hunkStart ? [i.row.text] : []))
  assert.deepEqual(anchors, ['two', 'old'])
})

test('a fold between two changed runs starts a second hunk', () => {
  const rows = [change, ...ctxRows(40), change]
  const items = diffItems({ rows, gaps: {} }, { full: true })
  const anchors = items.flatMap((i) => (i.kind === 'row' && i.hunkStart ? [i.index] : []))
  assert.deepEqual(anchors, [0, 41])
})

test('the cap counts drawn rows, not parsed ones', () => {
  // 500 context rows around one change: almost all of it folds away, so a cap
  // of 10 rendered rows must not fire.
  const rows = [change, ...ctxRows(500)]
  const items = diffItems({ rows, gaps: {} }, { full: true, maxRows: 10 })
  assert.equal(
    items.some((i) => i.kind === 'note'),
    false
  )
  // Unfolded, the same rows do hit the cap.
  const flat = diffItems({ rows, gaps: {} }, { full: false, maxRows: 10 })
  assert.deepEqual(flat[flat.length - 1], { kind: 'note', text: '… diff truncated' })
})

test('a directional expander opens one step from the end it points at', () => {
  assert.deepEqual(expandStep([10, 100], 'top', 20), [10, 29])
  assert.deepEqual(expandStep([10, 100], 'bottom', 20), [81, 100])
  assert.deepEqual(expandStep([10, 100], 'all', 20), [10, 100])
})

test('a gap shorter than one step opens whole, from either end', () => {
  assert.deepEqual(expandStep([10, 15], 'top', 20), [10, 15])
  assert.deepEqual(expandStep([10, 15], 'bottom', 20), [10, 15])
})

// `countRows` sizes the placeholder that stands in for an unmounted file in the
// changes view, so it has to agree with the parse it is standing in for. Every
// case below asserts the two together rather than a bare number: a count that
// drifts from `parseDiff` is a placeholder the wrong size, which is a scrollbar
// that lies and a jump when you scroll back up.
const agrees = (diff: string): number => {
  const n = parseDiff(diff).rows.length
  assert.equal(countRows(diff), n)
  return n
}

test('countRows agrees with parseDiff on an ordinary hunk', () => {
  assert.equal(
    agrees(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1111111..2222222 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,4 +1,4 @@',
        ' const keep = 1',
        '-const gone = 2',
        '+const here = 2',
        ' const tail = 3',
        ''
      ].join('\n')
    ),
    4
  )
})

test('countRows does not mistake a file header for a row', () => {
  // The two-header preamble is the case a newline count gets wrong, twice per
  // file — and `---`/`+++` are the only three-marker runs a diff can contain.
  const withHeaders = agrees(
    ['--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n')
  )
  assert.equal(withHeaders, 2)
})

test('countRows counts a body line that is itself a diff marker', () => {
  // A deleted Markdown rule is `----` on the wire and an added one `+++++`:
  // three of a marker in a row is a header only in the preamble, never inside
  // a hunk. Deciding by shape rather than position gets all three of these
  // wrong.
  assert.equal(
    agrees(['--- a/x.md', '+++ b/x.md', '@@ -1,2 +1,2 @@', '----', '+++++', ' ---', ''].join('\n')),
    3
  )
})

test('countRows counts a no-newline note and skips every other header', () => {
  assert.equal(
    agrees(
      [
        'diff --git a/x b/x',
        'old mode 100644',
        'new mode 100755',
        'index 1111111..2222222',
        '--- a/x',
        '+++ b/x',
        '@@ -1 +1 @@',
        '-one',
        '\\ No newline at end of file',
        '+two',
        ''
      ].join('\n')
    ),
    3
  )
})

test('countRows counts across several hunks and several files', () => {
  const file = (name: string): string =>
    [
      `diff --git a/${name} b/${name}`,
      `--- a/${name}`,
      `+++ b/${name}`,
      '@@ -1,3 +1,3 @@',
      ' ctx',
      '-old',
      '+new',
      '@@ -20,3 +20,3 @@',
      ' ctx',
      '-old',
      '+new',
      ''
    ].join('\n')
  assert.equal(agrees(file('a.ts') + file('b.ts')), 12)
})

test('countRows reports nothing for an empty diff, one row for a binary one', () => {
  assert.equal(countRows(''), 0)
  assert.equal(countRows('\n'), 0)
  // A binary notice *is* a row — parseDiff keeps it as a note.
  assert.equal(
    agrees(
      ['diff --git a/x.png b/x.png', 'Binary files a/x.png and b/x.png differ', ''].join('\n')
    ),
    1
  )
})

test('countRows counts blank lines and notes inside a hunk', () => {
  // Inside a hunk every line draws, blank ones included: they are context lines
  // whose single leading space git wrote and something downstream trimmed.
  assert.equal(agrees(['@@ -1,3 +1,3 @@', ' a', '', '+b', ''].join('\n')), 3)
})
