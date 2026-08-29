/**
 * A handle on the language-server client for the two callers that must not
 * *load* it.
 *
 * `lspClient.ts` pulls `@codemirror/view` and `@codemirror/lsp-client` — ~470 KB
 * that only matters once a file is open — and it was imported statically by
 * `store.ts` and `main.tsx`, which are the two modules on the path to first
 * paint. So the editor's protocol layer was evaluated at launch for every
 * session, including every one that never opens a file, and lazy-loading
 * `CodeEditor` alone would have moved none of it.
 *
 * Both callers want the same thing: tell the servers something *if any are
 * running*. If none are, there is nothing to say — no editor has been opened,
 * so no server was ever started — which is exactly the case a dynamic `import()`
 * at the call site would get wrong, by fetching half a megabyte in order to
 * discover it had nothing to do.
 *
 * So the direction is inverted: the client registers itself when its chunk
 * loads, and until then every call here is a no-op. That also settles
 * `releaseAllServers`, which runs on `beforeunload` — synchronous by nature, and
 * somewhere an `await import()` could never have completed in time.
 */
interface LspHooks {
  notifyWatchedChanges(paths: string[]): void
  releaseAllServers(): void
}

let hooks: LspHooks | null = null

/** Called by `lspClient.ts` at module scope, i.e. when the editor chunk lands. */
export function registerLspHooks(next: LspHooks): void {
  hooks = next
}

/**
 * Tell every running server that these files changed on disk. A no-op before
 * the first file is opened, which is correct rather than merely cheap: with no
 * client loaded there is no server holding a stale copy of anything.
 */
export function notifyWatchedChanges(paths: string[]): void {
  hooks?.notifyWatchedChanges(paths)
}

/** Drop this window's claim on every server it started. */
export function releaseAllServers(): void {
  hooks?.releaseAllServers()
}
