import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * One choice out of a few, shown all at once: a well of options with the
 * chosen one raised out of it (index.css, "Depth"). It was hand-rolled four
 * times — Usage's two pickers, Settings' color mode and sidebar rows, the
 * theme import's source tabs — each a pixel off the others.
 *
 * `tabs` swaps the button semantics for a tablist's, for the one place the
 * segments switch what is shown below rather than set a value.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'md',
  tabs,
  disabled,
  className
}: {
  value: T
  options: readonly { id: T; label: string; icon?: React.ComponentType<{ className?: string }> }[]
  onChange: (id: T) => void
  ariaLabel: string
  /** `sm` for a toolbar, `md` for a form row, `touch` thumb-sized with the segments sharing the width. */
  size?: 'sm' | 'md' | 'touch'
  tabs?: boolean
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div
      role={tabs ? 'tablist' : 'group'}
      aria-label={ariaLabel}
      className={cn(
        'surface-group flex shrink-0 gap-0.5',
        size === 'sm' ? 'rounded-lg p-0.5' : 'rounded-[11px] p-[3px]',
        disabled && 'opacity-55',
        className
      )}
    >
      {options.map((o) => {
        const on = value === o.id
        return (
          <button
            key={o.id}
            type="button"
            disabled={disabled}
            {...(tabs ? { role: 'tab', 'aria-selected': on } : { 'aria-pressed': on })}
            onClick={() => onChange(o.id)}
            className={cn(
              'flex items-center justify-center gap-1.5 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5',
              size === 'sm' && 'rounded-md px-2.5 py-1 text-[11px]',
              size === 'md' && 'h-7 rounded-lg px-2.5 text-xs',
              size === 'touch' && 'h-9 flex-1 rounded-lg px-2 text-[13.5px]',
              on ? 'surface-raised text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {o.icon && <o.icon />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
