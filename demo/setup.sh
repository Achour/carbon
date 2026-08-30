#!/bin/bash
# Rebuild the three demo repositories the screenshot profile points at.
#
#   ./demo/setup.sh
#
# `demo/repos/<name>` is each project at HEAD and `<name>.patch` is its
# uncommitted working tree — the shots want a repo with changes in it, and a
# patch is the only way to carry "modified but not committed" through a commit.
# The checkouts themselves are gitignored: they are generated, and nesting three
# git repositories inside this one is worse than regenerating them.
set -euo pipefail

DEMO="$(cd "$(dirname "$0")" && pwd)"
cd "$DEMO"

msg_nimbus="Nimbus landing page scaffold"
msg_pulse="Ingest endpoint with per-project rate limiting"
msg_atlas="Quickstart and querying docs"

rm -rf projects worktrees
mkdir -p projects

for p in nimbus pulse atlas; do
  cp -R "repos/$p" "projects/$p"
  cd "projects/$p"
  git init -q
  git add -A
  eval "git -c user.name=Carbon -c user.email=demo@example.com commit -qm \"\$msg_$p\""
  # An empty patch is a project with a clean tree, which is also a state worth
  # shooting — `git apply` refuses one, so only apply what has content.
  [ -s "../../repos/$p.patch" ] && git apply "../../repos/$p.patch"
  cd "$DEMO"
done

# One chat runs in a worktree, which is the whole point of the branch chip in
# the sidebar's detailed rows — so the branch has to actually exist on disk.
git -C projects/pulse worktree add -q -b rate-limits "$DEMO/worktrees/pulse-rate-limits" >/dev/null

echo "demo projects built. Next:"
echo "  AIGUI_USERDATA=$DEMO/userdata npm run dev   # once, so the app writes the schema, then quit"
echo "  node $DEMO/seed.mjs"
