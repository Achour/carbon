import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Just the pill, for the places that need a switch without a labelled row:
 * a provider's own switch, which sits inline beside its name and version; a
 * capability switch, which needs a `disabled` state the labelled `Toggle` has
 * no notion of; and a project's two visibility switches.
 *
 * It moved out of `Settings.tsx` when the second page needed one. A switch is
 * the control a settings page is most often read *by shape* rather than by
 * label, so two of them drawn a pixel apart would be the page contradicting
 * itself about what a switch looks like.
 */
export function SwitchPill({
  on,
  disabled,
  label,
  onChange
}: {
  on: boolean
  disabled?: boolean
  label: string
  onChange: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'relative h-[18px] w-8 shrink-0 rounded-full transition-colors',
        on && !disabled ? 'bg-primary' : 'bg-secondary',
        disabled && 'cursor-not-allowed opacity-40'
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] left-[2px] size-3.5 rounded-full bg-background shadow-sm transition-transform',
          on && !disabled && 'translate-x-[14px]'
        )}
      />
    </button>
  )
}
