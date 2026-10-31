import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLine, observe, pageDelta } from '../src/main/previewDelta.ts'

const obs = (lines: string[], focused: string | null = null, truncated = false) => observe(lines.join('\n'), focused, truncated)

test('an unchanged page has no delta', () => {
  const a = obs(['- heading "Inbox" [ref=d:e1] level=1', '- button "New" [ref=d:e2]'])
  assert.deepEqual(pageDelta(a, a), { kind: 'none' })
})

test('scrolling into view and focus are not changes', () => {
  const a = obs(['- button "Save" [ref=d:e2] (offscreen)', '  - textbox "Name" [ref=d:e3] value="x"'])
  const b = obs(['- button "Save" [ref=d:e2] [focused]', '  - textbox "Name" [ref=d:e3] value="x" (offscreen)'], 'button "Save"')
  assert.deepEqual(pageDelta(a, b), { kind: 'none', focus: 'Focus is now on button "Save".' })
})

test('focused is stripped from a longer state list', () => {
  assert.equal(normalizeLine('  - checkbox "A" [ref=d:e4] [checked, focused] (offscreen)'), 'checkbox "A" [ref=d:e4] [checked]')
})

test('a dialog opening shows as additions in place', () => {
  const a = obs(['- button "Delete" [ref=d:e2]', '- text: "footer"'])
  const b = obs(['- button "Delete" [ref=d:e2]', '- dialog "Confirm":', '  - button "Yes" [ref=d:e9]', '- text: "footer"'])
  assert.deepEqual(pageDelta(a, b), { kind: 'lines', lines: ['+ dialog "Confirm":', '+ button "Yes" [ref=d:e9]'] })
})

test('the same ref changing state is one ~ line', () => {
  const a = obs(['- checkbox "Remember" [ref=d:e5]', '- text: "1 item"'])
  const b = obs(['- checkbox "Remember" [ref=d:e5] [checked]', '- text: "2 items"'])
  assert.deepEqual(pageDelta(a, b), {
    kind: 'lines',
    lines: ['~ checkbox "Remember" [ref=d:e5] [checked]', '+ text: "2 items"', '- text: "1 item"']
  })
})

test('repeated identical lines keep their count', () => {
  const a = obs(['- listitem: "row"', '- listitem: "row"'])
  const b = obs(['- listitem: "row"', '- listitem: "row"', '- listitem: "row"'])
  assert.deepEqual(pageDelta(a, b), { kind: 'lines', lines: ['+ listitem: "row"'] })
})

test('a remount gives new refs: removal and addition, not a change', () => {
  const a = obs(['- button "Go" [ref=d:e2]'])
  const b = obs(['- button "Go" [ref=d:e7]'])
  assert.deepEqual(pageDelta(a, b), { kind: 'lines', lines: ['+ button "Go" [ref=d:e7]', '- button "Go" [ref=d:e2]'] })
})

test('skipRef drops the field the action already reported', () => {
  const a = obs(['- textbox "Email" [ref=d:e3] value=""', '- button "Send" [ref=d:e4] [disabled]'])
  const b = obs(['- textbox "Email" [ref=d:e3] value="a@b.co"', '- button "Send" [ref=d:e4]'])
  assert.deepEqual(pageDelta(a, b, { skipRef: 'd:e3' }), { kind: 'lines', lines: ['~ button "Send" [ref=d:e4] (was [disabled])'] })
})

test('past the line cap the answer is large, never partial', () => {
  const a = obs([])
  const b = obs(Array.from({ length: 41 }, (_, i) => `- text: "line ${i}"`))
  assert.deepEqual(pageDelta(a, b), { kind: 'large', count: 41 })
})

test('past the character cap the answer is large', () => {
  const a = obs([])
  const b = obs(['- text: "' + 'x'.repeat(3000) + '"'])
  assert.equal(pageDelta(a, b).kind, 'large')
})

test('a middle too big to diff cheaply is large without an LCS', () => {
  const a = obs(Array.from({ length: 600 }, (_, i) => `- text: "a${i}"`))
  const b = obs(Array.from({ length: 600 }, (_, i) => `- text: "b${i}"`))
  assert.deepEqual(pageDelta(a, b), { kind: 'large', count: 1200 })
})

test('losing focus is reported', () => {
  const a = obs(['- button "X" [ref=d:e1]'], 'button "X"')
  const b = obs(['- button "X" [ref=d:e1]'], null)
  assert.deepEqual(pageDelta(a, b), { kind: 'none', focus: 'Nothing is focused now.' })
})

test('a state that went away is named', () => {
  const a = obs(['- button "Send" [ref=d:e5] [disabled]'])
  const b = obs(['- button "Send" [ref=d:e5]'])
  assert.deepEqual(pageDelta(a, b), { kind: 'lines', lines: ['~ button "Send" [ref=d:e5] (was [disabled])'] })
})

test('focus landing on the target is not reported', () => {
  const a = obs(['- button "Go" [ref=d:e1]'])
  const b = obs(['- button "Go" [ref=d:e1] [focused]'], 'button "Go"')
  assert.deepEqual(pageDelta(a, b, { target: 'button "Go"' }), { kind: 'none' })
})

test('a ref pushed past a truncated capture, still on the page, is not reported removed', () => {
  const rows = Array.from({ length: 5 }, (_, i) => `- button "Edit ${i}" [ref=d:e${i}]`)
  const a = obs(rows, null, true)
  const b = obs(['- status: "Saved"', ...rows.slice(0, 4)], null, true)
  assert.deepEqual(pageDelta(a, b, { present: new Set(['d:e4']) }), {
    kind: 'lines',
    lines: ['+ status: "Saved"'],
    partial: true,
    crossed: true
  })
})

test('a reorder across the boundary is not a removal', () => {
  const a = obs(['- button "1" [ref=d:e1]', '- button "2" [ref=d:e2]'], null, true)
  const b = obs(['- button "2" [ref=d:e2]', '- button "3" [ref=d:e3]'], null, true)
  const d = pageDelta(a, b, { present: new Set(['d:e1']) })
  assert.deepEqual(d, { kind: 'lines', lines: ['+ button "3" [ref=d:e3]'], partial: true, crossed: true })
})

test('a ref gone from the page is a removal even when truncated', () => {
  const a = obs(['- heading "List" [ref=d:e1]', '- button "Yes" [ref=d:e7]', '- listitem: "x"'], null, true)
  const b = obs(['- heading "List" [ref=d:e1]', '- listitem: "x"', '- listitem: "y"'], null, true)
  assert.deepEqual(pageDelta(a, b, { present: new Set() }), {
    kind: 'lines',
    lines: ['- button "Yes" [ref=d:e7]', '+ listitem: "y"'],
    partial: true,
    crossed: true
  })
})

test('a change above the boundary on a truncated page is exact', () => {
  const a = obs(['- text: "Pending"', '- button "A" [ref=d:e1]', '- listitem: "b"'], null, true)
  const b = obs(['- text: "Done"', '- button "A" [ref=d:e1]', '- listitem: "b"'], null, true)
  // A text line is either side of the swap; either may have crossed, so it is worded as such.
  assert.deepEqual(pageDelta(a, b), { kind: 'lines', lines: ['+ text: "Done"', '- text: "Pending"'], partial: true, crossed: true })
})

test('equal text at the end of a truncated capture is never read as removed silently', () => {
  const a = obs(['- text: "a"', '- text: "b"', '- text: "repeat"', '- text: "repeat"'], null, true)
  const b = obs(['- status: "toast"', '- text: "a"', '- text: "b"', '- text: "repeat"'], null, true)
  assert.deepEqual(pageDelta(a, b), { kind: 'lines', lines: ['+ status: "toast"', '- text: "repeat"'], partial: true, crossed: true })
})

test('a state change at the end of a truncated capture is kept and exact', () => {
  const a = obs(['- heading "List" [ref=d:e1]', '- checkbox "Last" [ref=d:e9]'], null, true)
  const b = obs(['- heading "List" [ref=d:e1]', '- checkbox "Last" [ref=d:e9] [checked]'], null, true)
  assert.deepEqual(pageDelta(a, b), { kind: 'lines', lines: ['~ checkbox "Last" [ref=d:e9] [checked]'], partial: true })
})

test('skipRef keeps a state change on the typed field', () => {
  const a = obs(['- textbox "Email" [ref=d:e3] value=""'])
  const b = obs(['- textbox "Email" [ref=d:e3] value="bad" [invalid]'])
  assert.deepEqual(pageDelta(a, b, { skipRef: 'd:e3' }), {
    kind: 'lines',
    lines: ['~ textbox "Email" [ref=d:e3] value="bad" [invalid]']
  })
})

test('skipRef keeps the typed field leaving the page', () => {
  const a = obs(['- textbox "Code" [ref=d:e3] value=""', '- text: "x"'])
  const b = obs(['- text: "x"'])
  assert.deepEqual(pageDelta(a, b, { skipRef: 'd:e3' }), { kind: 'lines', lines: ['- textbox "Code" [ref=d:e3] value=""'] })
})

test('focused inside quoted page text is content, not state', () => {
  assert.equal(normalizeLine('- text: "Status [focused]"'), 'text: "Status [focused]"')
  assert.equal(normalizeLine('- button "A [focused]" [ref=d:e1] [focused]'), 'button "A [focused]" [ref=d:e1]')
  assert.equal(normalizeLine('- combobox "Size" [ref=d:e2] value="M" options=["S","M"] [expanded=false, focused]'), 'combobox "Size" [ref=d:e2] value="M" options=["S","M"] [expanded=false]')
})

test('a removal the page could not be asked about is worded as unproven', () => {
  const a = obs(['- button "1" [ref=d:e1]', '- button "2" [ref=d:e2]'], null, true)
  const b = obs(['- button "2" [ref=d:e2]'], null, true)
  assert.deepEqual(pageDelta(a, b), { kind: 'lines', lines: ['- button "1" [ref=d:e1]'], partial: true, crossed: true })
})
