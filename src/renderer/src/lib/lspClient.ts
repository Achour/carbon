import { EditorView } from '@codemirror/view'
import { ChangeSet, type Extension, type Text } from '@codemirror/state'
import {
  LSPClient,
  LSPPlugin,
  Workspace,
  hoverTooltips,
  serverCompletion,
  signatureHelp,
  type Transport,
  type WorkspaceFile
} from '@codemirror/lsp-client'
import type * as lsp from 'vscode-languageserver-protocol'
import { lspDiagnostics, dropLspDiagnostics } from '@/lib/lspDiagnostics'
import { lspLanguageId } from '@/lib/editorLanguage'
import { basename } from '@/lib/format'
import { viewForPath } from '@/lib/editorBuffers'
import { useApp } from '@/store'

/**
 * The renderer half of go-to-definition.
 *
 * `@codemirror/lsp-client` runs the whole protocol here; `main/lsp.ts` is only a
 * framed pipe to the server process. The seam is `Transport`, which wants a
 * `send` and a subscription — both of which IPC already provides, so the bridge
 * below is the entire integration.
 */

/**
 * `WorkspaceFileUpdate` is the return shape of `Workspace.syncFiles` but is not
 * exported by the package; declared here structurally so the override typechecks.
 */
interface WorkspaceFileUpdate {
  file: WorkspaceFile
  prevDoc: Text
  changes: ChangeSet
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

/** One shared IPC subscription, demultiplexed by server id. */
const handlers = new Map<string, Set<(value: string) => void>>()
let unsubscribe: (() => void) | null = null

function ensureBridge(): void {
  if (unsubscribe) return
  unsubscribe = window.api.onLspMessage((id, message) => {
    const set = handlers.get(id)
    if (!set) return
    for (const handler of set) handler(message)
  })
}

function transportFor(id: string): Transport {
  ensureBridge()
  return {
    send(message) {
      void window.api.lspSend(id, message)
    },
    subscribe(handler) {
      let set = handlers.get(id)
      if (!set) handlers.set(id, (set = new Set()))
      set.add(handler)
    },
    unsubscribe(handler) {
      handlers.get(id)?.delete(handler)
    }
  }
}

export function pathToUri(path: string): string {
  // encodeURI leaves `#` and `?` alone, and both are legal in a filename.
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

export function uriToPath(uri: string): string {
  const withoutScheme = uri.startsWith('file://') ? uri.slice('file://'.length) : uri
  return decodeURIComponent(withoutScheme)
}

/**
 * Carbon's workspace: the default one in the package is fine at tracking open
 * files, but its `displayFile` can only ever return an editor that is *already*
 * open — which makes a jump into an unopened file silently do nothing, and that
 * is the majority of jumps. Overriding it is the whole reason for subclassing.
 */
class CarbonWorkspace extends Workspace {
  files: WorkspaceFile[] = []
  private versions: Record<string, number> = Object.create(null)

  private nextVersion(uri: string): number {
    return (this.versions[uri] = (this.versions[uri] ?? -1) + 1)
  }

  syncFiles(): readonly WorkspaceFileUpdate[] {
    const result: WorkspaceFileUpdate[] = []
    for (const file of this.files) {
      const view = file.getView()
      const plugin = view ? LSPPlugin.get(view) : null
      if (!plugin || !view) continue
      const changes: ChangeSet = plugin.unsyncedChanges
      if (changes.empty) continue
      result.push({ changes, file, prevDoc: file.doc })
      file.doc = view.state.doc
      file.version = this.nextVersion(file.uri)
      plugin.clear()
    }
    return result
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    // Re-opening the same uri happens on a tab switch (the view is destroyed and
    // rebuilt); rebind rather than throwing the way the default workspace does.
    const existing = this.files.find((f) => f.uri === uri)
    if (existing) {
      ;(existing as MutableFile).view = view
      return
    }
    const file: MutableFile = {
      uri,
      languageId,
      version: this.nextVersion(uri),
      doc: view.state.doc,
      view,
      getView() {
        return this.view
      }
    }
    this.files.push(file)
    this.client.didOpen(file)
  }

  closeFile(uri: string): void {
    const file = this.files.find((f) => f.uri === uri)
    if (!file) return
    this.files = this.files.filter((f) => f !== file)
    dropLspDiagnostics(uri)
    this.client.didClose(uri)
  }

  /**
   * Put a file in front of the user for a jump. Goes through the store's own
   * `openFile`, so the target lands in a normal Carbon tab — with its preview
   * slot, its path bar and its close button — rather than in some editor the
   * LSP layer owns. The view then has to be *waited* for: opening a tab reads
   * the file over IPC and mounts CodeMirror on a later frame.
   */
  async displayFile(uri: string): Promise<EditorView | null> {
    const path = uriToPath(uri)
    const existing = viewForPath(path)
    if (existing) return existing
    await useApp.getState().openFile(path, { preview: true })
    for (let i = 0; i < 60; i++) {
      const view = viewForPath(path)
      if (view) return view
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    return null
  }
}

interface MutableFile extends WorkspaceFile {
  view: EditorView
  doc: Text
  version: number
}

/** One client per (project root, language) — the same key main starts servers on. */
const clients = new Map<string, Promise<LSPClient | null>>()
/** Server ids in use, so a closing editor can release the right one. */
const serverIds = new Map<string, string>()

/**
 * Why a file has no language features, kept so the editor can *say* so.
 *
 * This used to be a `console.info` and nothing else, which made go-to-definition
 * look broken rather than unavailable — the user ⌘-clicks a symbol, nothing
 * happens, and there is no way to tell a missing server from a missing
 * definition.
 */
export type JumpFailure =
  | { kind: 'unsupported' }
  | { kind: 'not-installed'; bin: string; install: string }
  | { kind: 'failed' }

const failures = new Map<string, JumpFailure>()

async function clientFor(root: string, languageId: string): Promise<LSPClient | null> {
  const key = `${root} ${languageId}`
  const cached = clients.get(key)
  if (cached) return cached
  const task = (async () => {
    const status = await window.api.lspEnsure(root, languageId)
    if (!status.ok) {
      // Not an error worth a dialog: a project without a server just has no
      // jumps, exactly as a machine without a provider CLI has no model rows.
      failures.set(
        key,
        status.reason === 'not-installed'
          ? { kind: 'not-installed', bin: status.bin, install: status.install }
          : { kind: 'unsupported' }
      )
      // Deliberately *not* cached, unlike an initialize failure below. Re-probing
      // costs a few `stat`s in main and spawns nothing, and this is the one
      // failure that heals on its own: a fresh worktree is opened before
      // `setup.sh` has finished, so `node_modules` — and with it the project's
      // own server — appears a minute after the first file does. A cached null
      // would leave that project with no jumps until it was reopened.
      clients.delete(key)
      return null
    }
    serverIds.set(key, status.id)
    const client = new LSPClient({
      rootUri: pathToUri(root),
      workspace: (c) => new CarbonWorkspace(c),
      // Spelled out rather than `languageServerExtensions()`, which is the same
      // list plus `serverDiagnostics()` — and that one dispatches
      // `setDiagnostics`, replacing the whole diagnostic set and erasing the
      // grammar's syntax errors. `lspDiagnostics()` is the same feature routed
      // through a lint source so the two can coexist.
      extensions: [serverCompletion(), hoverTooltips(), signatureHelp(), lspDiagnostics()],
      // A cold tsserver on a large repo takes well over the 3s default before it
      // answers anything, and a timed-out initialize leaves the editor with no
      // language features at all until the tab is reopened.
      timeout: 20_000
    }).connect(transportFor(status.id))

    // A server can be installed and still refuse to start — the common case is
    // `typescript-language-server` in a project with no TypeScript for it to
    // load. Waiting for `initialize` here is what turns that into "no language
    // features", the same answer as a missing binary, instead of an unhandled
    // rejection and an editor that keeps sending requests into a dead process.
    try {
      await client.initializing
    } catch (err) {
      // JSON-RPC failures arrive as a plain `{code, message}` from the server,
      // not an Error — `String(err)` on one prints "[object Object]" and hides
      // the only sentence that says what is actually wrong.
      console.info(`[lsp] ${languageId} server failed to start in ${root}: ${errorText(err)}`)
      failures.set(key, { kind: 'failed' })
      client.disconnect()
      void window.api.lspRelease(status.id)
      serverIds.delete(key)
      // The null stays cached deliberately: a server that cannot initialize will
      // not initialize on the next file either, and retrying per tab would spawn
      // a doomed process every time one is opened.
      return null
    }
    failures.delete(key)
    return client
  })()
  clients.set(key, task)
  return task
}

/**
 * The LSP extension for one file, or null when nothing can serve it. Awaited off
 * the mount path in `CodeEditor` — connecting spawns a process, and first paint
 * must not wait for it.
 */
export async function lspExtension(path: string): Promise<Extension | null> {
  // The project root is the store's, not a parameter: it is the same value for
  // every editor in the window, and threading it through the component only
  // created a second way for the two to disagree.
  const cwd = useApp.getState().selectedCwd
  if (!cwd) return null
  const languageId = lspLanguageId(basename(path))
  if (!languageId) return null
  const client = await clientFor(cwd, languageId)
  if (!client) return null
  // `plugin()` and not `languageServerSupport()`: the config above already
  // installs the shared bundle, and the latter would add a second completion
  // source and a second hover tooltip on top of it.
  return client.plugin(pathToUri(path), languageId)
}

/** Why this file has no language features, or null when it has them. */
export function jumpFailure(path: string): JumpFailure | null {
  const cwd = useApp.getState().selectedCwd
  const languageId = lspLanguageId(basename(path))
  if (!cwd || !languageId) return { kind: 'unsupported' }
  return failures.get(`${cwd} ${languageId}`) ?? null
}

export type JumpResult = 'jumped' | 'none' | 'unavailable'

/**
 * A server may answer with a `Location` or — if it decided to, since we do not
 * ask for them — a `LocationLink`, which names the same thing with different
 * keys. Normalizing both is three lines and the alternative is a jump that
 * silently does nothing against a server that prefers the newer shape.
 */
function asLocation(value: unknown): { uri: string; range: lsp.Range } | null {
  if (!value || typeof value !== 'object') return null
  const loc = value as lsp.Location & lsp.LocationLink
  if (typeof loc.uri === 'string') return { uri: loc.uri, range: loc.range }
  if (typeof loc.targetUri === 'string') {
    return { uri: loc.targetUri, range: loc.targetSelectionRange ?? loc.targetRange }
  }
  return null
}

/**
 * ⌘-click / F12, as the package's own `jumpToDefinition` does it — with the one
 * addition that makes the gesture explainable: **a result.**
 *
 * The packaged command is a `Command`, so it returns a synchronous boolean that
 * means "a request was sent", and the interesting outcome — the server answered
 * with no definition — resolves inside a promise it swallows. Both failures then
 * look identical from outside (nothing happens), and the one the user hits first
 * is a *missing server*, which is a fact worth stating rather than a dead click.
 * Reimplementing costs the ~20 lines below because every piece is public API.
 */
export async function jumpToDefinitionAt(view: EditorView): Promise<JumpResult> {
  const plugin = LSPPlugin.get(view)
  if (!plugin) return 'unavailable'
  const client = plugin.client
  if (client.serverCapabilities?.definitionProvider === false) return 'unavailable'
  // Push pending edits first, so the server resolves the symbol against the
  // document actually on screen rather than the one it last heard about.
  client.sync()
  const pos = view.state.selection.main.head
  return client.withMapping(async (mapping): Promise<JumpResult> => {
    let response: unknown
    try {
      response = await client.request('textDocument/definition', {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(pos)
      })
    } catch (err) {
      plugin.reportError('Find definition failed', err)
      return 'unavailable'
    }
    const loc = asLocation(Array.isArray(response) ? response[0] : response)
    if (!loc) return 'none'
    // `displayFile` is the override above: it opens a real Carbon tab and waits
    // for CodeMirror to mount, which is what makes a cross-file jump work.
    const target = loc.uri === plugin.uri ? view : await client.workspace.displayFile(loc.uri)
    if (!target) return 'none'
    // A file that was already open may have been edited while the request was in
    // flight; one that was just opened has no mapping and needs a plain convert.
    const anchor = mapping.getMapping(loc.uri)
      ? mapping.mapPosition(loc.uri, loc.range.start)
      : plugin.fromPosition(loc.range.start, target.state.doc)
    target.dispatch({ selection: { anchor }, scrollIntoView: true, userEvent: 'select.definition' })
    // Scrolling a symbol into view in an editor that does not have focus leaves
    // the cursor invisible, which reads as a jump that half-happened.
    target.focus()
    return 'jumped'
  })
}

/**
 * The agent just finished a turn and may have rewritten half the project. Files
 * the user has open are re-synced by the editor itself; everything *else* the
 * server has cached is now stale, and a server that keeps answering from it
 * sends the user to a line that has moved.
 */
export function notifyWatchedChanges(paths: string[]): void {
  if (paths.length === 0) return
  const changes = paths.map((path) => ({ uri: pathToUri(path), type: 2 as const }))
  for (const pending of clients.values()) {
    void pending.then((client) => {
      if (client?.connected) client.notification('workspace/didChangeWatchedFiles', { changes })
    })
  }
}

/** Release every server this window holds (project switch, window close). */
export function releaseAllServers(): void {
  for (const id of serverIds.values()) void window.api.lspRelease(id)
  serverIds.clear()
  for (const pending of clients.values()) void pending.then((client) => client?.disconnect())
  clients.clear()
}
