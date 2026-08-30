import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  WrapText,
} from "lucide-react";
import type { GitFileChange } from "@shared/types";
import { cn } from "@/lib/utils";
import { useStableChanges } from "@/lib/useStableChanges";
import { scopedChanges, useApp, type ChangeScope } from "@/store";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GitActionButton, LineDeltas } from "@/components/GitPanel";
import { keyOf } from "@/components/MultiDiffView";

const SCOPES: { id: ChangeScope; label: string; hint: string }[] = [
  {
    id: "last-turn",
    label: "Last Turn",
    hint: "This chat's last turn's changes",
  },
  { id: "uncommitted", label: "Uncommitted", hint: "All working-tree changes" },
  {
    id: "branch",
    label: "Branch",
    hint: "Everything on this branch vs its base",
  },
];

const NO_CHANGES: GitFileChange[] = [];

/** Clearance for the sticky file header when a jump lands on a hunk. */
const HUNK_SCROLL_MARGIN = 56;

/**
 * The review's one top bar, spanning **both** columns — the stacked diffs and
 * the source-control dock beside them.
 *
 * It was two bars first, one per column, aligned to the same height. That reads
 * as two panels that happen to line up, and it forced the dock to stack a
 * branch line over an action button while the left had a single row: the strip
 * was one row tall on one side and two on the other, which is the part that
 * looked wrong however carefully the heights were matched. Cursor puts scope,
 * branch and the commit action in one strip above everything, and the shape is
 * the point — so this is rendered by `RightPanel`, above the column split,
 * rather than by either column.
 *
 * That placement is also why the review's collapse state lives in the store
 * (`diffCollapsed`): "collapse all" is pressed out here, above the component
 * that owns the sections.
 */
export function ReviewBar({ cwd }: { cwd: string }): React.JSX.Element {
  const git = useApp((s) => s.git);
  const changeScope = useApp((s) => s.changeScope);
  const setChangeScope = useApp((s) => s.setChangeScope);
  const branchChanges = useApp((s) => s.branchChanges);
  const activeId = useApp((s) => s.activeId);
  const chats = useApp((s) => s.chats);
  const messages = useApp((s) => s.messages);
  const fetchRemote = useApp((s) => s.fetchRemote);
  const diffWrap = useApp((s) => s.diffWrap);
  const toggleDiffWrap = useApp((s) => s.toggleDiffWrap);
  const collapsed = useApp((s) => s.diffCollapsed);
  const setDiffCollapsed = useApp((s) => s.setDiffCollapsed);
  const explorerOpen = useApp((s) => s.explorerOpen);
  const toggleExplorer = useApp((s) => s.toggleExplorer);

  const [refreshing, setRefreshing] = React.useState(false);

  const isBranch = changeScope === "branch";
  const rawChanges = React.useMemo(
    () =>
      scopedChanges(
        { changeScope, git, branchChanges, activeId, chats, messages },
        cwd,
      ) ?? NO_CHANGES,
    [changeScope, git, branchChanges, activeId, chats, messages, cwd],
  );
  const changes = useStableChanges(rawChanges);
  const scopeMeta = SCOPES.find((s) => s.id === changeScope) ?? SCOPES[1];
  const totalAdd = changes.reduce((n, c) => n + (c.additions ?? 0), 0);
  const totalDel = changes.reduce((n, c) => n + (c.deletions ?? 0), 0);

  const allCollapsed =
    changes.length > 0 && changes.every((c) => collapsed[keyOf(c)]);
  const toggleAll = (): void =>
    setDiffCollapsed(
      allCollapsed
        ? {}
        : Object.fromEntries(changes.map((c) => [keyOf(c), true])),
    );

  /** Scroll to the next/previous change across every expanded file. */
  const jumpHunk = (dir: 1 | -1): void => {
    const root = document.querySelector<HTMLElement>("[data-changes-scroller]");
    if (!root) return;
    const rootTop = root.getBoundingClientRect().top;
    const tops = Array.from(
      root.querySelectorAll<HTMLElement>("[data-diff-hunk]"),
    ).map(
      (n) =>
        n.getBoundingClientRect().top -
        rootTop +
        root.scrollTop -
        HUNK_SCROLL_MARGIN,
    );
    const here = root.scrollTop;
    const target =
      dir === 1
        ? tops.find((t) => t > here + 2)
        : [...tops].reverse().find((t) => t < here - 2);
    if (target === undefined) return;
    root.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  };

  const hasChanges = changes.length > 0;

  return (
    <div className="@container flex h-8 shrink-0 items-center gap-1.5 overflow-hidden border-b border-border/60 pr-1.5 pl-2.5 text-[length:var(--ui-row)] text-muted-foreground">
      <DropdownMenu>
        <WithTooltip label={scopeMeta.hint}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="-ml-1 h-6 shrink-0 gap-1 px-1.5 text-[length:var(--ui-row)] font-normal text-foreground/90"
              >
                {scopeMeta.label}
                <ChevronDown className="size-3 text-muted-foreground" />
              </Button>
            }
          />
        </WithTooltip>
        <DropdownMenuContent align="start" className="min-w-52">
          {SCOPES.map((s) => (
            <DropdownMenuItem key={s.id} onClick={() => setChangeScope(s.id)}>
              <span className="flex min-w-0 flex-col">
                <span
                  className={cn(
                    "text-[length:var(--ui-row)]",
                    s.id === changeScope && "text-primary",
                  )}
                >
                  {s.label}
                </span>
                <span className="text-[length:var(--ui-row)] text-muted-foreground">
                  {s.hint}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <LineDeltas additions={totalAdd} deletions={totalDel} />

      {isBranch && branchChanges?.baseBranch && (
        <span className="truncate text-[length:var(--ui-row)] text-muted-foreground/60">
          vs {branchChanges.baseBranch}
        </span>
      )}

      {/* The branch, inline — Cursor puts it right beside the scope rather than
          heading the column it belongs to. */}
      {git?.branch && (
        // Hidden in a narrow panel rather than truncated: at the default width
        // it renders as "m…", which names nothing, and the ~55px it costs is
        // what the primary action needs to say "Publish repository" instead of
        // "Publish …". The chat's own context strip carries the branch anyway.
        <span className="hidden min-w-0 shrink items-center gap-1 pl-1 @[36rem]:flex">
          <GitBranch className="size-3 shrink-0 text-muted-foreground/70" />
          <span className="truncate">{git.branch}</span>
          {git.ahead > 0 && (
            <span className="flex shrink-0 items-center">
              {git.ahead}
              <ArrowUp className="size-2.5" />
            </span>
          )}
          {git.behind > 0 && (
            <span className="flex shrink-0 items-center">
              {git.behind}
              <ArrowDown className="size-2.5" />
            </span>
          )}
        </span>
      )}

      <div className="min-w-1 flex-1" />

      {/* Shrinkable, not `shrink-0`. The bar clips (`overflow-hidden`), so a
          right cluster that refuses to give ground doesn't overflow visibly —
          it gets *sliced*, and the casualty is always the last thing in it:
          the primary action, cut in half at the panel's default width. The
          icons inside still hold their size; what yields is the one control
          that can say the same thing smaller (a truncated pill, and its label
          below `@[38rem]`). */}
      <div className="flex min-w-0 shrink items-center gap-0.5">
        {hasChanges && (
          <div className="flex shrink-0 items-center">
            <WithTooltip label="Previous change">
              <Button
                size="icon-sm"
                variant="ghost"
                className="size-6"
                aria-label="Previous change"
                onClick={() => jumpHunk(-1)}
              >
                <ArrowUp />
              </Button>
            </WithTooltip>
            <WithTooltip label="Next change">
              <Button
                size="icon-sm"
                variant="ghost"
                className="size-6"
                aria-label="Next change"
                onClick={() => jumpHunk(1)}
              >
                <ArrowDown />
              </Button>
            </WithTooltip>
          </div>
        )}

        {hasChanges && (
          <WithTooltip
            label={diffWrap ? "Do not wrap long lines" : "Wrap long lines"}
          >
            <Button
              size="icon-sm"
              variant="ghost"
              className={cn(
                "size-6 shrink-0",
                diffWrap && "bg-accent text-foreground",
              )}
              aria-label={
                diffWrap ? "Do not wrap long lines" : "Wrap long lines"
              }
              aria-pressed={diffWrap}
              onClick={toggleDiffWrap}
            >
              <WrapText />
            </Button>
          </WithTooltip>
        )}

        {hasChanges && (
          <WithTooltip
            label={allCollapsed ? "Expand every file" : "Collapse every file"}
          >
            <Button
              size="sm"
              variant="ghost"
              className="h-6 shrink-0 gap-1 px-1.5 text-[length:var(--ui-row)] font-normal"
              onClick={toggleAll}
            >
              {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
              {/* Icon-only in a narrow panel: this is the one label in the
                  cluster whose glyph already says it, and the tooltip carries
                  the words. */}
              <span className="hidden @[38rem]:inline">
                {allCollapsed ? "Expand all" : "Collapse all"}
              </span>
            </Button>
          </WithTooltip>
        )}

        <WithTooltip label="Fetch & refresh">
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-6 shrink-0"
            aria-label="Fetch and refresh git status"
            onClick={() => {
              setRefreshing(true);
              void fetchRemote().finally(() => setRefreshing(false));
            }}
          >
            <RefreshCw className={cn(refreshing && "animate-spin")} />
          </Button>
        </WithTooltip>

        <WithTooltip label={explorerOpen ? "Hide file tree" : "Show file tree"}>
          <Button
            size="icon-sm"
            variant="ghost"
            // No active tint: the glyph itself flips (panel open vs closed), so
            // brightening it as well only made this one icon a different color
            // from the rest of the cluster.
            className="size-6 shrink-0"
            aria-label={explorerOpen ? "Hide file tree" : "Show file tree"}
            aria-pressed={explorerOpen}
            onClick={toggleExplorer}
          >
            {explorerOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
        </WithTooltip>

        <GitActionButton />
      </div>
    </div>
  );
}
