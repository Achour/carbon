/**
 * Keyboard input for the preview, as CDP `Input.dispatchKeyEvent` parameters.
 *
 * A key event is not one field but four that have to agree — `key` (what the
 * page reads), `code` (the physical key), `windowsVirtualKeyCode` (what
 * Chromium's own editing code reads, and what `keydown.keyCode` reports) and
 * `text` (what gets inserted). Send `key: "Enter"` alone and React sees the
 * keydown while the form never submits; send `text` without the rest and an
 * input gets the character with no keydown at all. This table is the agreement.
 *
 * Dependency-free on purpose — `node --test` runs it straight off the `.ts`.
 */

export interface KeyDispatch {
  key: string
  code: string
  windowsVirtualKeyCode: number
  /** Inserted text for a printable key; absent for a control key. */
  text?: string
  /** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
  modifiers: number
  /**
   * Chromium editing commands to run with the keydown. A synthetic Meta+A
   * selects nothing on macOS — the shortcut is resolved by the native menu,
   * which a CDP event never reaches — so the command is named outright.
   */
  commands?: string[]
}

const MODIFIER_BITS = { alt: 1, control: 2, meta: 4, shift: 8 } as const

const MODIFIER_ALIASES: Record<string, keyof typeof MODIFIER_BITS> = {
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  ctrl: 'control',
  control: 'control',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  shift: 'shift'
}

const NAMED: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 }
}

for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i }

const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  ';': { code: 'Semicolon', keyCode: 186 },
  '=': { code: 'Equal', keyCode: 187 },
  ',': { code: 'Comma', keyCode: 188 },
  '-': { code: 'Minus', keyCode: 189 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  '\\': { code: 'Backslash', keyCode: 220 },
  ']': { code: 'BracketRight', keyCode: 221 },
  "'": { code: 'Quote', keyCode: 222 }
}

/** Editing commands for the shortcuts a page cannot receive as raw keys. */
const EDIT_COMMANDS: Record<string, string> = {
  a: 'selectAll',
  c: 'copy',
  x: 'cut',
  v: 'paste',
  z: 'undo'
}

/**
 * Parses `"Enter"`, `"a"`, `"Shift+Tab"`, `"Meta+K"`, `"Control+Shift+ArrowLeft"`.
 * The last segment is the key and everything before it a modifier; a lone `+`
 * is the plus key. Returns an error string for anything it cannot place, so the
 * tool can say what was wrong instead of sending a key the page never sees.
 */
export function parseKeyCombo(input: string): KeyDispatch | { error: string } {
  const raw = input.trim()
  if (!raw) return { error: 'key is required (e.g. "Enter", "Tab", "Meta+A").' }
  // `+` on its own, or a combo ending in `++`, names the plus key.
  const parts = raw === '+' ? ['+'] : raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+')
  const keyPart = parts.pop() ?? ''
  let modifiers = 0
  for (const m of parts) {
    const name = MODIFIER_ALIASES[m.trim().toLowerCase()]
    if (!name) return { error: `Unknown modifier "${m}". Use Alt, Control, Meta or Shift.` }
    modifiers |= MODIFIER_BITS[name]
  }
  const shift = (modifiers & MODIFIER_BITS.shift) !== 0
  // A printable key carries text only when no command modifier is held: Ctrl+A
  // and Meta+A insert nothing, Shift+A inserts "A".
  const printable = (modifiers & (MODIFIER_BITS.control | MODIFIER_BITS.meta | MODIFIER_BITS.alt)) === 0

  const named = NAMED[keyPart.toLowerCase()]
  if (named) {
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.keyCode,
      ...(named.text && printable ? { text: named.text } : {}),
      modifiers
    }
  }
  if ([...keyPart].length !== 1) {
    return { error: `Unknown key "${keyPart}". Use a single character or a name like Enter, Tab, Escape, ArrowDown, PageDown, F5.` }
  }
  const ch = keyPart
  let dispatch: KeyDispatch
  if (/^[a-z]$/i.test(ch)) {
    const upper = ch.toUpperCase()
    const key = shift ? upper : ch.toLowerCase()
    dispatch = { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers }
  } else if (/^[0-9]$/.test(ch)) {
    dispatch = { key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0), modifiers }
  } else if (PUNCTUATION[ch]) {
    dispatch = { key: ch, code: PUNCTUATION[ch].code, windowsVirtualKeyCode: PUNCTUATION[ch].keyCode, modifiers }
  } else {
    // Anything else (a shifted symbol, a non-ASCII letter) has no physical key
    // to name; Chromium accepts it as text with an empty code.
    dispatch = { key: ch, code: '', windowsVirtualKeyCode: 0, modifiers }
  }
  if (printable) dispatch.text = dispatch.key
  // Only the shortcut exactly — Meta or Control alone, plus Shift for redo — so
  // Meta+Shift+Z is redo rather than undo, and Alt+Meta+A is nothing.
  const primary = modifiers === MODIFIER_BITS.meta || modifiers === MODIFIER_BITS.control
  const shifted = modifiers === (MODIFIER_BITS.meta | MODIFIER_BITS.shift) || modifiers === (MODIFIER_BITS.control | MODIFIER_BITS.shift)
  const lower = ch.toLowerCase()
  if (primary && EDIT_COMMANDS[lower]) dispatch.commands = [EDIT_COMMANDS[lower]]
  else if (shifted && lower === 'z') dispatch.commands = ['redo']
  else if (modifiers === MODIFIER_BITS.control && lower === 'y') dispatch.commands = ['redo']
  return dispatch
}
