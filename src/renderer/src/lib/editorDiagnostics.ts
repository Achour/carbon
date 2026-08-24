import { syntaxTree } from '@codemirror/language'
import { linter, type Diagnostic } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { LSPPlugin } from '@codemirror/lsp-client'
import { takeLspDiagnostics } from '@/lib/lspDiagnostics'
import { widenPoint } from '@/lib/diagnosticRange'

/**
 * Everything that puts a squiggle under code, merged into **one** lint source.
 *
 * That merge is forced by `@codemirror/lint`'s shape rather than chosen:
 * `setDiagnostics` replaces the entire diagnostic set, so two things calling it
 * — the package's own `serverDiagnostics()` and any `linter()` — erase each
 * other, whichever fires last. Sources, by contrast, are collected and batched.
 * So the language server's diagnostics are routed through a source too (see
 * `lspDiagnostics.ts`) and joined here with the grammar's.
 *
 * The two answer different questions and only one of them needs anything
 * installed:
 *
 * - **The grammar** already parses every open file to highlight it, and it
 *   records where it failed. That is a *syntax* error — an unclosed brace, a
 *   stray token — and it costs nothing extra, works offline, and works for
 *   every language with a CodeMirror grammar.
 * - **The server** knows types, imports and symbols. That is everything the
 *   grammar cannot see, and it needs a language server on the machine.
 */

/** Past this many, the file is broken in a way a list cannot usefully describe. */
const MAX_SYNTAX_ERRORS = 100

/**
 * Syntax errors, read off the Lezer tree the highlighter already built.
 *
 * Lezer recovers from bad input rather than stopping, and marks each place it
 * had to as an error node — so "where are the syntax errors" is a walk of a
 * tree that exists anyway, not a second parse.
 *
 * Two shapes have to be handled. A *missing* token is a zero-length node (the
 * parser inserted nothing at a point), and a zero-length range draws no
 * squiggle at all, so it is widened onto the character beside it. A *stray*
 * token has real width and is reported as-is.
 */
export function syntaxDiagnostics(view: EditorView): Diagnostic[] {
  const { state } = view
  const tree = syntaxTree(state)
  // A large file is parsed incrementally, and the unparsed tail is not an
  // error — it is simply not read yet. Reporting past this point would put
  // squiggles under perfectly good code every time a big file opens.
  const parsedTo = tree.length
  if (parsedTo === 0) return []

  const out: Diagnostic[] = []
  tree.iterate({
    to: parsedTo,
    enter: (node) => {
      if (!node.type.isError || out.length >= MAX_SYNTAX_ERRORS) return
      const line = state.doc.lineAt(node.from)
      let range =
        node.from === node.to
          ? widenPoint(node.from, line.from, line.to)
          : { from: node.from, to: node.to }
      // The error landed on a blank line, which has nothing to underline. This
      // is not a rare shape: an unclosed bracket is reported at end of file,
      // and a file ending in a newline makes that a blank line every time.
      // Mark the last line that has something on it — the nearest place a
      // reader can act on, and far better than a diagnostic that silently
      // renders nothing.
      for (let n = line.number - 1; !range && n >= 1; n--) {
        const prev = state.doc.line(n)
        if (prev.to > prev.from) range = { from: prev.to - 1, to: prev.to }
      }
      if (!range) return
      out.push({
        from: range.from,
        to: range.to,
        severity: 'error',
        // No `source`: the lint tooltip prints it under the message, and
        // "Syntax error / syntax" says the same thing twice. A server's
        // diagnostics keep theirs ("ts", "eslint"), which is where naming the
        // origin actually distinguishes anything.
        // The grammar knows *that* it failed here, not what was intended —
        // claiming more (`expected ")"`) would be inventing a diagnosis Lezer
        // did not make.
        message: 'Syntax error'
      })
    }
  })
  return out
}

/**
 * The editor's diagnostics. `delay` is the pause after typing before squiggles
 * are recomputed: mid-word, almost every line is briefly unparseable, and
 * flagging that as you type would be noise rather than information.
 */
export const diagnostics: Extension = linter(
  (view) => {
    const syntax = syntaxDiagnostics(view)
    const plugin = LSPPlugin.get(view)
    if (!plugin) return syntax
    return [...syntax, ...takeLspDiagnostics(plugin)]
  },
  { delay: 500 }
)
