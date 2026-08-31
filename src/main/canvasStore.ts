import { randomUUID } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { Canvas, CanvasSummary } from '@shared/types'

/**
 * Additive and unversioned, deliberately. `userData` is shared between the dev
 * and packaged builds (and between branches), so an older build has to be able
 * to open a database this one has written — which `CREATE TABLE IF NOT EXISTS`
 * gives for free and a `user_version` bump is the one way to break.
 *
 * Its own table rather than a column on `chats`: a canvas is project-scoped and
 * outlives the chat that wrote it, and keeping the body out of `chats.meta`
 * means opening a chat never pays for a canvas it isn't showing.
 */
export const CANVAS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS canvases (
    id         TEXT PRIMARY KEY,
    project    TEXT NOT NULL,
    chat_id    TEXT,
    title      TEXT NOT NULL,
    html       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS canvases_project ON canvases(project, updated_at DESC);
`

/**
 * A canvas larger than this is refused rather than truncated. The cap is not
 * about disk — it is that the body crosses IPC to a renderer that has to parse
 * it, and half a document renders as a broken one with no way to tell.
 */
export const MAX_CANVAS_BYTES = 4 * 1024 * 1024

type Row = {
  id: string
  project: string
  chat_id: string | null
  title: string
  created_at: number
  updated_at: number
}

function summary(row: Row): CanvasSummary {
  return {
    id: row.id,
    project: row.project,
    chatId: row.chat_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Every canvas in `chats.db`, keyed by project.
 *
 * Takes the open handle rather than opening its own: one database means one
 * WAL, one lock and one rolling `.bak`, so a canvas is backed up by the
 * machinery that already backs up the chats.
 */
export class CanvasStore {
  private selList: StatementSync
  private selOne: StatementSync
  private upsert: StatementSync
  private del: StatementSync
  /**
   * An explicit field rather than a parameter property, the concession
   * `LspManager` already makes: `test/canvasStore.test.ts` imports this file
   * directly and `node --test`'s type-stripping rejects the shorthand.
   */
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.db.exec(CANVAS_SCHEMA)
    // Summaries only — `html` is deliberately absent, so listing a project with
    // forty canvases reads none of their bodies.
    this.selList = this.db.prepare(
      'SELECT id, project, chat_id, title, created_at, updated_at FROM canvases WHERE project = ? ORDER BY updated_at DESC'
    )
    this.selOne = this.db.prepare('SELECT * FROM canvases WHERE id = ?')
    this.upsert = this.db.prepare(
      `INSERT INTO canvases (id, project, chat_id, title, html, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         html = excluded.html,
         updated_at = excluded.updated_at`
    )
    this.del = this.db.prepare('DELETE FROM canvases WHERE id = ?')
  }

  list(project: string): CanvasSummary[] {
    if (!project) return []
    return (this.selList.all(project) as Row[]).map(summary)
  }

  get(id: string): Canvas | null {
    const row = this.selOne.get(id) as (Row & { html: string }) | undefined
    return row ? { ...summary(row), html: row.html } : null
  }

  /**
   * Create or replace. An `id` that names an existing canvas updates it in
   * place — keeping `created_at` and `project`, which is what makes "revise the
   * canvas" a revision rather than a second row with the same title.
   */
  save(input: {
    id?: string
    project: string
    chatId?: string | null
    title: string
    html: string
  }): CanvasSummary {
    const html = input.html ?? ''
    if (Buffer.byteLength(html, 'utf8') > MAX_CANVAS_BYTES) {
      throw new Error(
        `Canvas is too large (limit ${Math.round(MAX_CANVAS_BYTES / 1024 / 1024)} MB). Split it or trim embedded data.`
      )
    }
    const now = Date.now()
    const existing = input.id ? this.get(input.id) : null
    const id = existing?.id ?? input.id ?? randomUUID()
    const title = input.title.trim() || 'Untitled canvas'
    const row: CanvasSummary = {
      id,
      // An update never moves a canvas between projects: the id is the identity,
      // and a caller passing a different cwd is a worktree, not a new home.
      project: existing?.project ?? input.project,
      chatId: existing ? existing.chatId : (input.chatId ?? null),
      title,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    this.upsert.run(
      row.id,
      row.project,
      row.chatId,
      row.title,
      html,
      row.createdAt,
      row.updatedAt
    )
    return row
  }

  delete(id: string): void {
    this.del.run(id)
  }
}
