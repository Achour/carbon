# Imported themes

Settings → Appearance → **Add theme** brings in a theme someone else wrote: a
VS Code color theme from Open VSX, a `.json` file (VS Code or Carbon's
own export) dropped or chosen, or JSON pasted into the box. Code:
`shared/themeImport.ts` (conversion, dependency-free and tested in
`test/themeImport.test.ts`), `main/themeMarket.ts` + `main/zip.ts` (Open VSX),
`lib/themes.ts` (registry), `ThemeImportDialog.tsx`, `ThemePreview.tsx`.

## Try on, then keep

The dialog never saves on click. A card — an Open VSX result, or a theme from a
dropped or pasted file, drawn the same way on purpose — is *tried on*:
`previewTheme` paints it under a `data-theme='preview'` block and persists
nothing, and **Keep** is what adds it. Closing the dialog unmounts its body,
and that cleanup puts the saved theme back, so a preview cannot outlive it
(nor survive a relaunch). A drop or paste tries its first theme on at once,
since the drop is already the request to see it. There is no JSON textarea:
paste lands anywhere in the dialog, on either tab.

**`prefers-color-scheme` is not the OS.** It answers for
`nativeTheme.themeSource`, which a Light/Dark mode, a pinned theme and a
preview all force. `lib/themes.ts` therefore reads it only while the window
follows the system and remembers it otherwise (`noteNativeMode`, fed by the
store's single `setNativeAppearance`), and System mode's change listener is
ignored while a preview is up — the preview's own forced appearance fires it,
and answering re-applied the saved theme the instant a preview began.

## One appearance, pinned

A built-in theme is authored in both modes (see `lib/themes.ts`). An imported
one is a single appearance — a VS Code theme is *either* dark or light — so it
**pins** the window to that appearance while selected. The stored Color mode is
left untouched, so picking a built-in again brings it back; the Color mode row
says "Set by <theme>" and disables rather than silently doing nothing.

Pinning has to reach three places, and each was a leak until it did:

- `applyTheme` resolves to the theme's appearance instead of the mode.
- `index.html`'s pre-paint script cannot see the registry, so `applyTheme`
  writes `themeAppearance` to localStorage for it; without it a pinned dark
  theme under Light mode flashes light on every launch.
- `setWindowAppearance` gets `effectiveThemeMode`, or `nativeTheme` and the
  vibrancy material stay on the Color mode's tone under a theme of the other.

An extension shipping both halves (Catppuccin's Latte and Mocha) is not paired
into one two-mode theme: which dark pairs with which light is a choice the
extension doesn't make, and guessing it wrong is worse than two cards.

## Storage

localStorage (`customThemes`), like the theme id itself: it is synchronous, so
`installThemes` paints an imported theme before React mounts. `storedTheme`
consults the full registry, or a saved imported id would be reset to Carbon on
every launch. Only the converted variables are kept — an import is a one-time
translation, not a live link. Ids derive from source + name, so importing the
same theme again replaces it instead of duplicating it. Each theme gets one
`:root[data-theme='…']` block in its own `<style>` (no appearance qualifier:
it always matches its pinned appearance), which outranks `.dark` in
`index.css`, so imported `--syn-*` win.

## The mapping

`deriveVars` is the one deriver: every source fills what it can into a seed
map, and the rest is derived from background and foreground. **Every seed is
taken only while it stays legible on its ground** — VS Code themes routinely
give a button fill that is unreadable as text (Dracula's `button.background`
is ~1.6:1 on its editor), and Carbon uses `--primary` as both. So `primary`
is the first of `button.background`, `focusBorder`, `textLink.foreground`, …
that reads at 2.5:1, not the first that exists. Translucent workbench colors
(`list.hoverBackground: #44475a75`) are composited over the surface they would
be painted on.

Beyond the chrome, a VS Code theme also supplies `--syn-*` (its `tokenColors`
matched to Carbon's eight coarse token groups — see `SYNTAX_SCOPES`; descendant
selectors are skipped because they need a scope stack) and `--term-*` (its
ANSI palette, read by `TerminalPanel`'s `themeColors`). Both are optional:
absent, `index.css` and the terminal's literals apply.

## Open VSX

Public, unauthenticated API, fetched from main (every file is a 302 to another
host the renderer's CORS would refuse). Only the manifest is served as a loose
file — theme JSON lives inside the `.vsix`, so adding downloads the extension
(streamed against a 40 MB cap) and reads the few files it needs with
`zip.ts`, which parses the directory up front and inflates an entry only when
asked — under an 8 MB cap per entry, since the size an archive declares is its
own claim. It trusts the central directory's sizes, never the local headers:
vsce sets the data-descriptor flag and zeroes them. Converted results are
cached per extension in main (in flight or done), because every search
downloads its top hits and the next keystroke usually lists the same ones. `include` chains and a JSON
`tokenColors` path are resolved inside the zip; a `.tmTheme` one is skipped.

Search keeps only hits whose manifest contributes a color theme (the category
also holds icon themes), and re-ranks: Open VSX's relevance puts a fork with the
query in its *description* above the original ("Dracula Colorful" over Dracula
Official), so hits *named* for the query go first, most-downloaded first.

**Don't end a main-process string literal with the word `import`.**
electron-vite's ESM shim finds "the last import" with a regex, and
`"…too large to import"` followed by the next quote in the bundle matches it —
the shim is spliced into the middle of the string and the dev build fails with
"Unterminated string literal" at a line that looks fine.
