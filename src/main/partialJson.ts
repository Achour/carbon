/**
 * Best-effort parse of a JSON *prefix* — what a tool call's input looks like
 * while the model is still streaming it. The renderer draws a tool row from
 * its input (the command, the path), and until the block closes there is no
 * input at all, so a row read "Terminal" with a spinner for as long as the
 * model took to type the command. Closing whatever is open lets the summary
 * fill in as it streams instead.
 *
 * Dependency-free and pinned by `test/partialJson.test.ts`. Returns `undefined`
 * when no prefix of the text parses; never throws.
 */
export function parsePartialJson(raw: string): unknown {
  const text = raw.trimStart()
  if (!text) return undefined
  // Positions *after* a `,` or an opening bracket outside any string: places
  // the text can be cut back to when its tail is an unfinishable token (`tr`
  // of `true`, a bare `-`), which no amount of closing can complete.
  const cuts: number[] = []
  let i = 0
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      // Skip the string; a prefix may end inside it or inside an escape.
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === ',' || c === '{' || c === '[') cuts.push(i + 1)
  }
  const attempt = (end: number): unknown => {
    const closed = closeJson(text.slice(0, end))
    if (closed === null) return undefined
    try {
      return JSON.parse(closed)
    } catch {
      return undefined
    }
  }
  const whole = attempt(text.length)
  if (whole !== undefined) return whole
  for (let k = cuts.length - 1; k >= 0; k--) {
    const v = attempt(cuts[k])
    if (v !== undefined) return v
  }
  return undefined
}

/**
 * Append what a JSON prefix is missing: the close of an open string (backing
 * off a half-written escape first), a value for a key with none, and every
 * unclosed bracket. A dangling `,` is dropped. `null` when the prefix is not
 * the start of any JSON value.
 */
function closeJson(text: string): string | null {
  type Frame = { open: '{' | '['; colon: boolean }
  const stack: Frame[] = []
  let inString = false
  let stringStart = -1
  let i = 0
  for (; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      stringStart = i
      continue
    }
    if (c === '{' || c === '[') stack.push({ open: c, colon: false })
    else if (c === '}' || c === ']') {
      if (!stack.length) return null
      stack.pop()
    } else if (c === ':') {
      const top = stack[stack.length - 1]
      if (top?.open === '{') top.colon = true
    } else if (c === ',') {
      const top = stack[stack.length - 1]
      if (top?.open === '{') top.colon = false
    }
  }
  let out = text
  if (inString) {
    // A prefix ending inside an escape: `\` alone, or `\u` short of its four
    // hex digits. Back off to before the backslash rather than guessing.
    const tail = out.slice(stringStart + 1)
    const m = /\\(?:u[0-9a-fA-F]{0,3})?$/.exec(tail)
    if (m) out = out.slice(0, stringStart + 1 + m.index)
    out += '"'
    const top = stack[stack.length - 1]
    // The string was a key (object level, no colon yet): give it a value.
    if (top?.open === '{' && !top.colon) out += ':null'
  } else {
    const trimmed = out.trimEnd()
    const last = trimmed[trimmed.length - 1]
    if (last === ',') out = trimmed.slice(0, -1)
    else if (last === ':') out = trimmed + 'null'
    else if (last === '"') {
      // A completed key with nothing after it yet.
      const top = stack[stack.length - 1]
      if (top?.open === '{' && !top.colon) out = trimmed + ':null'
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) out += stack[k].open === '{' ? '}' : ']'
  return out
}
