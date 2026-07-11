import * as React from 'react'
import { Tooltip } from '@base-ui/react/tooltip'

/**
 * Wrap a single element with a tooltip. The child is used as the trigger via
 * Base UI's render prop, so no extra DOM node is introduced.
 */
export function WithTooltip({
  label,
  side = 'top',
  children
}: {
  label: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: React.ReactElement
}): React.JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children as React.ReactElement<Record<string, unknown>>} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={6} className="z-50">
          <Tooltip.Popup className="max-w-xs rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-lg transition-all duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

export const TooltipProvider = Tooltip.Provider
