import type { Canvas, CanvasSummary } from '@shared/types'

/** The tools Carbon's canvas surface exposes to every provider. */
export const CANVAS_TOOL_NAMES = ['write', 'edit', 'list', 'read'] as const

export type CanvasToolName = (typeof CANVAS_TOOL_NAMES)[number]

export function isCanvasToolName(value: string): value is CanvasToolName {
  return (CANVAS_TOOL_NAMES as readonly string[]).includes(value)
}

/**
 * One argument, described once.
 *
 * The same parameter is spelled three times downstream — a zod shape for
 * Claude's in-process server, a JSON Schema for the stdio child Codex and Grok
 * read, and a field pick in the bridge — and hand-copying them had already
 * drifted inside the commit that added `edit`: `id` was described two different
 * ways and `old_string`'s "omit only when renaming" reached Claude alone. That
 * is the silent provider asymmetry this codebase keeps ruling out, arriving by
 * the mechanism it warns about, so the declaration moved here and the three
 * spellings are derived from it.
 */
export type CanvasParam = {
  type: 'string' | 'boolean'
  required?: boolean
  description: string
}

export const CANVAS_TOOL_INFO: Record<
  CanvasToolName,
  { description: string; readOnly: boolean; params: Record<string, CanvasParam> }
> = {
  write: {
    description:
      'Create or update a canvas: a self-contained HTML document shown beside the chat in this app. Use it for anything the user will read and scan rather than run — comparisons, tables, architecture notes, reports, dashboards. The HTML may include its own <style> and <script>, so it can be interactive (sortable tables, tabs, charts). It is NOT written to the project, so it never appears in git or in your own file searches. This tool sends the WHOLE document, so use it to create a canvas or to rewrite one from scratch; to change part of one that already exists, use `edit` instead. Pass `id` to replace an existing canvas rather than creating a second one with the same title.',
    readOnly: false,
    params: {
      title: { type: 'string', required: true, description: 'Short title for the canvas.' },
      html: {
        type: 'string',
        required: true,
        description:
          'A complete, self-contained HTML document. Inline any CSS and JS; do not reference project files.'
      },
      id: {
        type: 'string',
        description: 'Id of an existing canvas to replace. Omit to create a new one.'
      }
    }
  },
  edit: {
    description:
      "Change part of an existing canvas in place, the way the file `Edit` tool changes a file: `old_string` is replaced by `new_string`, and everything else is left alone. Prefer this over `write` for every revision — `write` re-sends the whole document, so a one-line change to a large canvas costs thousands of output tokens and takes minutes, where an edit takes seconds. `old_string` must be unique in the document (include surrounding lines until it is) or pass `replace_all`. Call `read` first: a canvas attached to a message carries extracted text, not the HTML an edit has to match against. Pass `title` alone to rename a canvas without touching its body.",
    readOnly: false,
    params: {
      id: { type: 'string', required: true, description: 'Id of the canvas to edit.' },
      old_string: {
        type: 'string',
        description:
          'The exact text to replace, copied from the canvas HTML. Must appear exactly once unless replace_all is true. Omit only when renaming.'
      },
      new_string: {
        type: 'string',
        description: 'The text to replace it with. Required whenever old_string is given.'
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of failing when old_string is not unique.'
      },
      title: {
        type: 'string',
        description: 'New title. Pass it alone to rename the canvas without changing its body.'
      }
    }
  },
  list: {
    description:
      'List the canvases already saved for this project, newest first, with their ids and titles. Use it to find the id of a canvas you want to revise.',
    readOnly: true,
    params: {}
  },
  read: {
    description: 'Read back the full HTML of one canvas by id, so you can revise it.',
    readOnly: true,
    params: { id: { type: 'string', required: true, description: 'The canvas id.' } }
  }
}

/**
 * What every session appends so the model knows the canvas exists and which of
 * its document tools this one is.
 *
 * The last sentence is load-bearing on Claude specifically: Carbon sets
 * `CLAUDE_CODE_ARTIFACT`, so that session has *two* "make a document" tools and
 * the other one publishes to claude.ai. Left undisambiguated, "make me a page
 * comparing these" is a coin flip between a panel beside the chat and a URL.
 */
export const CANVAS_SESSION_RULES =
  'You are running inside Carbon, a desktop GUI. The `canvas` MCP server saves a self-contained HTML document that the user reads in a panel beside the chat: `write` (title + html) to create one, `edit` (id + old_string/new_string) to change one, `list`, `read`. Prefer a canvas whenever the answer is something to look at rather than a change to the code — a comparison, a table, a report, a diagram, a dashboard. A canvas is stored by the app, NOT written into the project, so it never dirties git and never shows up in your later file searches. Do not create files in the repo for this purpose. If an `Artifact` tool is also available, that one publishes to claude.ai and is only for when the user explicitly asks to publish or share a link; the canvas is the default. The panel follows the app\'s theme, which is usually dark: write the document for BOTH schemes — set `color-scheme: light dark` and give every colour you set a `@media (prefers-color-scheme: dark)` counterpart, or set no page background at all. A canvas that hardcodes a light background is a white sheet in a dark window. The user can also ATTACH a canvas to a message: it arrives as its title, its id, and its readable text (not its HTML). Treat that as context they are pointing at. If they ask you to change it, call `read` with that id for the full HTML and then `edit` for the parts that actually move; reserve `write` for creating a canvas or rewriting one wholesale. Never write a new canvas for an edit to an existing one.'

export type CanvasToolHost = {
  list(project: string): CanvasSummary[]
  get(id: string): Canvas | null
  save(input: {
    id?: string
    project: string
    chatId?: string | null
    title: string
    html: string
  }): CanvasSummary
}

/**
 * Everything a canvas call can carry, in one place. Spelled out separately in
 * the bridge and the stdio child it was three structurally-unrelated types, so
 * a field added to one and forgotten in another compiled cleanly and simply
 * never arrived — on Codex and Grok only, since Claude's server does not cross
 * the bridge.
 */
export type CanvasToolInput = {
  title?: string
  html?: string
  id?: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
}

export type CanvasToolResult = { kind: 'text'; text: string }

function text(t: string): CanvasToolResult {
  return { kind: 'text', text: t }
}

/**
 * Run one canvas tool against the host.
 *
 * `project` and `chatId` are injected by the caller rather than taken from the
 * model, for the reason `cwd` is on the preview tools: they are facts about the
 * session, and a model that could name its own project could write into another
 * one's list. `project` is the repo root, so a worktree chat's canvas belongs
 * to the project rather than to a directory that gets deleted.
 */
export function runCanvasTool(
  host: CanvasToolHost,
  ctx: { project: string; chatId?: string | null },
  name: CanvasToolName,
  input: CanvasToolInput = {}
): CanvasToolResult {
  switch (name) {
    case 'write': {
      const html = typeof input.html === 'string' ? input.html : ''
      if (!html.trim()) return text('Failed to write canvas: html is required.')
      const title = (input.title ?? '').trim()
      if (!title) return text('Failed to write canvas: title is required.')
      try {
        const saved = host.save({
          id: input.id,
          project: ctx.project,
          chatId: ctx.chatId ?? null,
          title,
          html
        })
        // The id is the whole result. Without it in the text the model has no
        // handle to revise this canvas with, and the next request for a change
        // silently produces a second row with the same title.
        return text(
          `Saved canvas "${saved.title}" (id: ${saved.id}). It is now in the Canvas panel. To change it later, call canvas edit with id: ${saved.id} rather than writing the document again. Do not repeat the HTML in your reply — tell the user the canvas is ready.`
        )
      } catch (err) {
        return text(`Failed to write canvas: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    /**
     * The whole reason this tool exists: `write` is O(document) in *output
     * tokens*, so every revision — a colour, a number, one row of a table —
     * cost the model the entire canvas again. Measured on this repo's own
     * chats: a 57-byte change to an 80 KB canvas took 281 seconds, which is
     * the generation time for ~22k tokens and nothing else. An edit is the
     * same change in ~50.
     *
     * The contract is deliberately `Edit`'s, down to the wording of the
     * failures: the model already knows how to recover from "not found" and
     * "appears N times" on a file, and a second dialect of the same tool would
     * only teach it a worse one.
     */
    case 'edit': {
      const id = (input.id ?? '').trim()
      if (!id) return text('Failed to edit canvas: id is required.')
      const existing = host.get(id)
      if (!existing) return text(`No canvas with id ${id}.`)
      const oldText = typeof input.old_string === 'string' ? input.old_string : ''
      const retitle = (input.title ?? '').trim()
      // A rename with no body change is the one edit that needs no strings —
      // and the one case where re-sending the document to change five
      // characters would be most absurd.
      if (!oldText && !retitle) {
        return text('Failed to edit canvas: old_string is required (or pass title alone to rename).')
      }
      let html = existing.html
      if (oldText) {
        // Optional in the schema only because a rename needs neither string.
        // Defaulted to '', a model that forgot it would silently *delete* what
        // it named — `Edit` requires it, and so does this.
        const newText = input.new_string
        if (typeof newText !== 'string') {
          return text(
            'Failed to edit canvas: new_string is required with old_string (pass an empty string to delete).'
          )
        }
        if (oldText === newText) {
          return text('Failed to edit canvas: old_string and new_string are identical.')
        }
        // One pass answers both questions: how many times it occurs, and what
        // the document looks like with it replaced. `join` is also what keeps
        // the replacement literal — `String.replace` would read a `$&` or `$1`
        // in it as a substitution pattern, and a canvas is a document full of
        // CSS and script that can contain either.
        const pieces = html.split(oldText)
        const hits = pieces.length - 1
        if (hits === 0) {
          return text(
            'Failed to edit canvas: old_string was not found in the canvas. It must match the HTML exactly, whitespace included — call canvas read to see the current document. Note that a canvas attached to a message carries extracted text, not HTML.'
          )
        }
        if (hits > 1 && input.replace_all !== true) {
          return text(
            `Failed to edit canvas: old_string appears ${hits} times. Include more surrounding text so it identifies one place, or pass replace_all: true to change all ${hits}.`
          )
        }
        html = pieces.join(newText)
      }
      try {
        const saved = host.save({
          id,
          project: ctx.project,
          chatId: ctx.chatId ?? null,
          title: retitle || existing.title,
          html
        })
        return text(
          `Updated canvas "${saved.title}" (id: ${saved.id}). The panel is showing the new version. Do not repeat the HTML in your reply — tell the user what changed.`
        )
      } catch (err) {
        return text(`Failed to edit canvas: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    case 'list': {
      const rows = host.list(ctx.project)
      if (!rows.length) return text('No canvases saved for this project yet.')
      return text(
        rows
          .map((c) => `${c.id}\t${c.title}\t${new Date(c.updatedAt).toISOString()}`)
          .join('\n')
      )
    }
    case 'read': {
      const id = (input.id ?? '').trim()
      if (!id) return text('Failed to read canvas: id is required.')
      const canvas = host.get(id)
      if (!canvas) return text(`No canvas with id ${id}.`)
      return text(canvas.html)
    }
  }
}
