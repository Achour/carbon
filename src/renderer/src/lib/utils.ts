import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * The bordered chip of the context strip above the composer — repo/branch, the
 * changes count, where the chat runs. One definition so the strip reads as a
 * single row of the same thing rather than drifting per component.
 */
export const contextPill =
  'flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-secondary/40 px-2 py-1 text-xs text-muted-foreground'

/**
 * The tag both places that can report a vanished folder render — the project
 * picker and the context strip. One definition so the two say it the same way;
 * they were already drifting apart at birth.
 */
/**
 * A full-width notice above the editor: the read-only banner and the conflict
 * bar. Both say "something about this file is not what you'd assume", and two
 * bars born in one change is where a drift starts.
 */
export const editorNotice =
  'flex items-center gap-2 border-b border-border bg-warning/10 px-3 py-1.5 text-[11px]'

export const missingTag =
  'shrink-0 rounded bg-warning/10 px-1.5 py-px text-[10px] text-warning'

/** Wording for the same, so the tooltip agrees with the tag. */
export const MISSING_TITLE = 'This folder no longer exists on disk'

/** `contextPill` for chips you can click. */
export const contextPillAction = cn(
  contextPill,
  'transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none'
)

/**
 * `contextPillAction` as an actual `<button>` in the strip: out of the window's
 * drag region, with the icon sized for a chip. Both pickers in that row render
 * one, and they sit side by side — a difference between them would read as two
 * kinds of control rather than two of the same.
 */
export const contextPillButton = cn(contextPillAction, 'no-drag [&>svg]:size-3 [&>svg]:shrink-0')
