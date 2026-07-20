/** What the OS calls its file manager, so the menu item reads natively. */
export const REVEAL_LABEL =
  window.api.platform === 'darwin'
    ? 'Reveal in Finder'
    : window.api.platform === 'win32'
      ? 'Show in File Explorer'
      : 'Show in file manager'
