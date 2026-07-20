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

/** `contextPill` for chips you can click. */
export const contextPillAction = cn(
  contextPill,
  'transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none'
)
