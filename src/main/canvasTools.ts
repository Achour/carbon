import type { Canvas, CanvasSummary } from '@shared/types'

/** The three tools Carbon's canvas surface exposes to every provider. */
export const CANVAS_TOOL_NAMES = ['write', 'list', 'read'] as const

export type CanvasToolName = (typeof CANVAS_TOOL_NAMES)[number]

export function isCanvasToolName(value: string): value is CanvasToolName {
  return (CANVAS_TOOL_NAMES as readonly string[]).includes(value)
}

export const CANVAS_TOOL_INFO: Record<
  CanvasToolName,
  { description: string; readOnly: boolean }
> = {
  write: {
    description:
      'Create or update a canvas: a self-contained HTML document shown beside the chat in this app. Use it for anything the user will read and scan rather than run — comparisons, tables, architecture notes, reports, dashboards. The HTML may include its own <style> and <script>, so it can be interactive (sortable tables, tabs, charts). It is NOT written to the project, so it never appears in git or in your own file searches. Pass `id` to revise an existing canvas instead of creating a second one.',
    readOnly: false
  },
  list: {
    description:
      'List the canvases already saved for this project, newest first, with their ids and titles. Use it to find the id of a canvas you want to revise.',
    readOnly: true
  },
  read: {
    description: 'Read back the full HTML of one canvas by id, so you can revise it.',
    readOnly: true
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
  'You are running inside Carbon, a desktop GUI. The `canvas` MCP server saves a self-contained HTML document that the user reads in a panel beside the chat: `write` (title + html, optionally an id to revise), `list`, `read`. Prefer a canvas whenever the answer is something to look at rather than a change to the code — a comparison, a table, a report, a diagram, a dashboard. A canvas is stored by the app, NOT written into the project, so it never dirties git and never shows up in your later file searches. Do not create files in the repo for this purpose. If an `Artifact` tool is also available, that one publishes to claude.ai and is only for when the user explicitly asks to publish or share a link; the canvas is the default. The panel follows the app\'s theme, which is usually dark: write the document for BOTH schemes — set `color-scheme: light dark` and give every colour you set a `@media (prefers-color-scheme: dark)` counterpart, or set no page background at all. A canvas that hardcodes a light background is a white sheet in a dark window.'

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
  input: { title?: string; html?: string; id?: string } = {}
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
          `Saved canvas "${saved.title}" (id: ${saved.id}). It is now in the Canvas panel. To revise it, call canvas write again with id: ${saved.id}. Do not repeat the HTML in your reply — tell the user the canvas is ready.`
        )
      } catch (err) {
        return text(`Failed to write canvas: ${err instanceof Error ? err.message : String(err)}`)
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
