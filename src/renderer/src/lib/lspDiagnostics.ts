import { forceLinting, type Diagnostic } from '@codemirror/lint'
import { LSPPlugin, type LSPClientExtension } from '@codemirror/lsp-client'
import type * as lsp from 'vscode-languageserver-protocol'

/**
 * The language server's half of the diagnostics, routed through a lint *source*
 * instead of the package's `serverDiagnostics()`.
 *
 * `serverDiagnostics()` dispatches `setDiagnostics` directly, which replaces the
 * whole diagnostic set — so it and any `linter()` silently erase one another,
 * and the file would show either its syntax errors or its type errors depending
 * on which fired last. Holding the server's push here and re-emitting it from a
 * source is what lets the two coexist (see `editorDiagnostics.ts`).
 *
 * The raw LSP payload is stored rather than the converted diagnostics, and the
 * conversion is done at lint time. Positions are line/character pairs against
 * the document the server last saw, so converting them later — through the
 * plugin's own `fromPosition` and its record of unsynced local edits — is
 * *more* accurate than converting on arrival and letting the result drift.
 */

const pending = new Map<string, readonly lsp.Diagnostic[]>()

const SEVERITY: Record<number, Diagnostic['severity']> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint'
}

/** Convert whatever the server last said about this editor's file. */
export function takeLspDiagnostics(plugin: LSPPlugin): Diagnostic[] {
  const raw = pending.get(plugin.uri)
  if (!raw) return []
  return raw.map((item) => ({
    from: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.start, plugin.syncedDoc)),
    to: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.end, plugin.syncedDoc)),
    severity: SEVERITY[item.severity ?? 1] ?? 'error',
    source: item.source ?? 'lsp',
    // LSP 3.18 widened `message` to allow MarkupContent; the lint panel and the
    // hover tooltip both want a plain string.
    message: typeof item.message === 'string' ? item.message : item.message.value
  }))
}

/**
 * Client extension: accept `publishDiagnostics` and re-run the linter, which
 * merges what arrived with the grammar's own findings.
 */
export function lspDiagnostics(): LSPClientExtension {
  return {
    clientCapabilities: { textDocument: { publishDiagnostics: { versionSupport: true } } },
    notificationHandlers: {
      'textDocument/publishDiagnostics': (client, params: lsp.PublishDiagnosticsParams) => {
        const file = client.workspace.getFile(params.uri)
        // A stale push — the server is answering about a version of the file
        // that has already been superseded locally.
        if (!file || (params.version != null && params.version !== file.version)) return false
        pending.set(params.uri, params.diagnostics)
        const view = file.getView()
        const plugin = view ? LSPPlugin.get(view) : null
        // A file with no editor on screen still records its diagnostics, so
        // they are there the moment the tab is opened.
        if (view && plugin) forceLinting(view)
        return true
      }
    }
  }
}

/** Forget a closed file, so its diagnostics don't outlive the tab. */
export function dropLspDiagnostics(uri: string): void {
  pending.delete(uri)
}
