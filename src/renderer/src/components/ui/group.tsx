import * as React from 'react'

/**
 * A section's rows as one card, the rows divided inside it (index.css,
 * "Depth"). The title sits above the card, outside it, so a page of several
 * reads as labelled blocks rather than one long list. Rows keep their own
 * `px-2 py-2.5`.
 */
export function Group({
  title,
  count,
  action,
  className,
  children
}: {
  title?: string
  /** Drawn after the title, dimmed; omitted at zero. */
  count?: number
  /** A small control at the title's far end, e.g. "Unpair all". */
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={className}>
      {(title || action) && (
        <div className="mb-1.5 flex items-center gap-2 px-1">
          <div className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
            {title}
            {count !== undefined && count > 0 && (
              <span className="ml-1.5 text-muted-foreground/60 tabular-nums">{count}</span>
            )}
          </div>
          {action}
        </div>
      )}
      <div className="surface-card divide-y divide-border/70 px-1.5 py-0.5">{children}</div>
    </div>
  )
}
