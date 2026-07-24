#!/bin/sh
# Swap the freshly built bundle into /Applications.
#
# Kept as a script rather than run from the agent because Carbon hosts the agent
# session itself: replacing the bundle from inside it would kill the process
# doing the replacing, half way through.
set -e

SRC="$(cd "$(dirname "$0")/.." && pwd)/dist/mac-arm64/Carbon.app"
DST="/Applications/Carbon.app"
STAMP=$(date +%Y%m%d-%H%M%S)

[ -d "$SRC" ] || { echo "No build at $SRC — run 'npm run package' first." >&2; exit 1; }

if pgrep -f "$DST/Contents/MacOS/Carbon" >/dev/null 2>&1; then
  echo "Carbon is still running. Quit it (Cmd-Q) and run this again." >&2
  echo "Quitting cleanly matters: it checkpoints the WAL and releases the chat locks." >&2
  exit 1
fi

if [ -d "$DST" ]; then
  # Timestamped, never reusing a name: an existing Carbon.app.old would swallow
  # the current bundle *inside* itself rather than being replaced by it.
  mv "$DST" "$DST.prev-$STAMP"
  echo "Previous bundle kept at $DST.prev-$STAMP"
fi

cp -R "$SRC" "$DST"
xattr -dr com.apple.quarantine "$DST" 2>/dev/null || true
echo "Installed $(du -sh "$DST" | cut -f1) to $DST"
echo "Open it, then open your largest chat — history older than the window sits"
echo "behind a 'Load earlier messages' button at the top."
