/**
 * Whether a CLI in a terminal chat is working, read off the window title it
 * sets. Dependency-free so `node --test` can run it directly.
 *
 * All three CLIs animate a spinner at the head of their title for exactly as
 * long as a turn runs, and drop it the moment it ends — measured: Claude Code
 * alternates `◐`/`◑` and settles on `✳`; Codex and Grok cycle braille frames
 * (`⠹ tchat`, `⠦ - Responding - grok`) and fall back to a bare title. That is
 * the one signal the three share, it needs no configuration, and it is what the
 * CLIs publish for exactly this purpose: a terminal's tab showing work.
 */

const OSC_TITLE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g

/** Longest unterminated sequence worth holding across chunks. */
const CARRY_MAX = 1024

/** Finds title changes in a pty's output, across chunk boundaries. */
export class TitleScanner {
  private carry = ''

  /** The last title set in `data`, or null when it sets none. */
  feed(data: string): string | null {
    const text = this.carry + data
    this.carry = ''
    let title: string | null = null
    let end = 0
    for (const match of text.matchAll(OSC_TITLE)) {
      title = match[1]
      end = match.index + match[0].length
    }
    // A sequence cut in half by the chunk boundary finishes in the next one.
    const open = Math.max(text.lastIndexOf('\x1b]'), text.endsWith('\x1b') ? text.length - 1 : -1)
    if (open >= end) {
      const tail = text.slice(open)
      if (tail.length <= CARRY_MAX && !/\x07|\x1b\\/.test(tail)) this.carry = tail
    }
    return title
  }
}

/** A braille spinner frame, or one of the quarter-circle frames. */
export function titleShowsWork(title: string): boolean {
  const code = title.trimStart().codePointAt(0)
  if (code === undefined) return false
  return (code > 0x2800 && code <= 0x28ff) || (code >= 0x25d0 && code <= 0x25d3)
}
