import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

// Every color here is a `var(--…)` rather than a literal, which is the whole
// point: the theme is installed once and never rebuilt when the user switches
// appearance or picks another theme in Settings. The CSS cascade re-paints the
// editor for free, where a JS-valued theme would need every open EditorView
// reconfigured on each change. `--syn-*` is shared with highlight.js (index.css)
// so a token cannot be one color in a chat code block and another in the editor.

const theme = EditorView.theme({
  '&': {
    color: 'var(--foreground)',
    backgroundColor: 'transparent',
    height: '100%',
    fontSize: 'var(--code-font-size)'
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.65',
    overflow: 'auto'
  },
  '.cm-content': {
    padding: '12px 0',
    caretColor: 'var(--foreground)'
  },
  '.cm-line': { padding: '0 14px' },

  // Gutter: matches the old viewer's sticky line-number column exactly — same
  // border, same muted 50% numbers — so switching to the editor is invisible.
  '.cm-gutters': {
    backgroundColor: 'var(--card)',
    color: 'color-mix(in oklch, var(--muted-foreground) 50%, transparent)',
    border: 'none',
    borderRight: '1px solid var(--border)'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px', minWidth: '2.5ch' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--card)',
    color: 'var(--muted-foreground)'
  },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 2px' },

  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--accent) 40%, transparent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--foreground)' },

  // Selection has to be given on both the drawn layer and the native one; which
  // is used depends on whether drawSelection is active for the current mode.
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 22%, transparent)'
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 12%, transparent)'
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 22%, transparent)'
  },

  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 18%, transparent)',
    outline: 'none'
  },
  '.cm-nonmatchingBracket': { color: 'var(--syn-meta)' },

  // Search panel — the app's own chrome rather than CodeMirror's default, since
  // it stands in for FindBar on editor tabs (see CodeEditor).
  '.cm-panels': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: 'none'
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '6px 8px', fontSize: '11px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    fontSize: '11px'
  },
  '.cm-panel.cm-search input[type=text]': {
    backgroundColor: 'var(--input, var(--muted))',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    padding: '2px 6px',
    outline: 'none'
  },
  '.cm-panel.cm-search button:not([name=close])': {
    backgroundColor: 'var(--muted)',
    backgroundImage: 'none',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    padding: '2px 6px'
  },
  '.cm-panel.cm-search [name=close]': {
    color: 'var(--muted-foreground)',
    fontSize: '14px',
    padding: '0 6px'
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in oklch, var(--syn-number) 28%, transparent)'
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in oklch, var(--syn-number) 55%, transparent)'
  },

  // Autocomplete + hover tooltips (LSP).
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    boxShadow: '0 4px 16px rgb(0 0 0 / 18%)'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'inherit',
    fontSize: 'var(--code-font-size)',
    maxHeight: '16em'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)'
  },
  '.cm-completionIcon': { paddingRight: '10px', opacity: 0.6 },
  '.cm-completionDetail': { color: 'var(--muted-foreground)', fontStyle: 'normal' },
  '.cm-tooltip-hover, .cm-tooltip-lint': { padding: '6px 8px', maxWidth: '48ch' },

  // Diagnostics. `--destructive` / `--warning` rather than syntax hues: these
  // mean *state*, which is exactly the distinction `--syn-*` is not for.
  '.cm-panel.cm-panel-lint ul': { maxHeight: '10em' },
  '.cm-panel.cm-panel-lint ul [aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)'
  },
  '.cm-panel.cm-panel-lint button[name=close]': {
    color: 'var(--muted-foreground)',
    right: '6px',
    top: '2px'
  },
  '.cm-diagnostic': {
    padding: '3px 8px',
    borderLeftWidth: '3px',
    fontFamily: 'inherit',
    fontSize: '11px'
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--destructive)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
  '.cm-diagnosticSource': { opacity: 0.6, fontSize: '10px' },
  // CodeMirror draws squiggles as a repeating background image; replacing it
  // with a real wavy underline keeps them crisp at any zoom and lets them take
  // a theme color.
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--destructive)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px'
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--warning)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px'
  },
  '.cm-lintRange-info, .cm-lintRange-hint': { backgroundImage: 'none' }
})

// The go-to-definition affordance lives in index.css, not here: the class is set
// on the *host* element wrapping the editor, and `EditorView.theme` rules are
// scoped under the view's own generated class, so a rule for it here would
// silently match nothing.

// Lezer tags mapped onto the same eight token colors highlight.js uses. The
// mapping is deliberately coarse: eight groups a reader can name beat thirty a
// reader perceives as noise, and it keeps the two highlighters honest — a finer
// CodeMirror palette would have no highlight.js counterpart to agree with.
const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  {
    tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self, t.null, t.tagName],
    color: 'var(--syn-keyword)'
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.literal, t.integer, t.float], color: 'var(--syn-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.className, t.heading], color: 'var(--syn-function)' },
  {
    tag: [t.propertyName, t.attributeName, t.typeName, t.namespace, t.definition(t.variableName), t.labelName],
    color: 'var(--syn-variable)'
  },
  { tag: [t.standard(t.variableName), t.macroName, t.atom, t.unit], color: 'var(--syn-builtin)' },
  { tag: [t.meta, t.processingInstruction, t.annotation, t.invalid, t.deleted], color: 'var(--syn-meta)' },
  { tag: [t.variableName, t.operator, t.punctuation, t.bracket, t.separator, t.content], color: 'var(--foreground)' },
  { tag: t.link, color: 'var(--syn-function)', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.strikethrough, textDecoration: 'line-through' }
])

export const editorTheme: Extension = [theme, syntaxHighlighting(highlightStyle)]
