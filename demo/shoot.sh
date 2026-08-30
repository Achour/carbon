#!/bin/bash
# Take screenshots of Carbon against the demo profile, and leave nothing running.
#
#   ./demo/shoot.sh <out-prefix> <delays-csv> <e2e-file>
#   ./demo/shoot.sh /tmp/hero 5000,9000 demo/e2e/hero.js
#
# **Killing `npm run dev` does not stop the app.** electron-vite spawns Electron
# as a child, and it is reparented to launchd the moment the npm process dies —
# so a loop of "launch, capture, kill $!" silently accumulates a running app per
# iteration, each one holding the demo profile's SQLite locks. This script kills
# the Electron root by finding it through a marker planted in its own
# environment, then asserts nothing from this repo survives; a stray instance is
# a failure, not a warning.
set -uo pipefail
# Each background job gets its OWN process group, so `kill -- -$PID` reaches the
# whole tree (npm -> electron-vite -> Electron) instead of the calling shell.
set -m

OUT="${1:?usage: shoot.sh <out-prefix> <delays-csv> <e2e-file>}"
DELAYS="${2:?}"
E2E_FILE="${3:-}"

DEMO="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$DEMO")"
MARKER="carbon-shoot-$$-$(date +%s)"
LOG="${TMPDIR:-/tmp}/$MARKER.log"

E2E=""
[ -n "$E2E_FILE" ] && E2E="$(cat "$E2E_FILE")"

# The marker rides an env var Carbon ignores, so it identifies this launch's
# Electron process even though its command line is identical to every other.
cd "$REPO" || exit 1
CARBON_SHOOT_ID="$MARKER" \
AIGUI_USERDATA="$DEMO/userdata" \
AIGUI_CAPTURE="$OUT.png" \
AIGUI_CAPTURE_DELAY="$DELAYS" \
AIGUI_E2E="$E2E" \
  npm run dev > "$LOG" 2>&1 &
NPM_PID=$!

# Last delay decides how long to wait, plus headroom for the dev build itself.
LAST=$(echo "$DELAYS" | tr ',' '\n' | sort -n | tail -1)
DEADLINE=$(( $(date +%s) + LAST / 1000 + 75 ))
COUNT=$(echo "$DELAYS" | tr ',' '\n' | grep -c .)
LASTSHOT="$OUT-$COUNT.png"
[ "$COUNT" = "1" ] && LASTSHOT="$OUT.png"

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  [ -f "$LASTSHOT" ] && sleep 2 && break
  sleep 1
done

# Kill the whole process GROUP first: `kill $NPM_PID` reaches only the npm
# wrapper, and Electron is its grandchild, so it is reparented to launchd and
# keeps running — which is how a loop of launches silently stacks up a dock full
# of apps, each heartbeating advisory locks against the demo profile.
kill -TERM -- "-$NPM_PID" 2>/dev/null
sleep 2
kill -9 -- "-$NPM_PID" 2>/dev/null
sleep 1

# Belt and braces: anything carrying this launch's marker, by PID.
mine=$(ps eww -o pid=,command= | grep "CARBON_SHOOT_ID=$MARKER" | grep -v grep | awk '{print $1}')
for p in $mine; do kill -9 "$p" 2>/dev/null; done

strays=$(ps -eo pid,ppid,command | awk '$2==1 && /ai-gui\/node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS/ {print $1}')
if [ -n "$strays" ]; then
  echo "!! electron survived, killing: $strays" >&2
  for p in $strays; do kill -9 "$p" 2>/dev/null; done
  sleep 1
fi

left=$(ps -eo command= | grep -c "[a]i-gui/node_modules/electron/dist/Electron.app/Contents/MacOS")
echo "e2e: $(grep -h 'e2e result\|e2e error' "$LOG" | tail -1)"
echo "shots: $(ls "$OUT"*.png 2>/dev/null | tr '\n' ' ')"
echo "electron still running: $left"
[ "$left" -eq 0 ] || exit 1
