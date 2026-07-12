import * as React from 'react'
import { Popover as BasePopover } from '@base-ui/react/popover'
import { cn } from '@/lib/utils'

const Popover = BasePopover.Root
const PopoverTrigger = BasePopover.Trigger

function PopoverContent({
  className,
  align = 'center',
  side = 'bottom',
  children,
  ...props
}: React.ComponentProps<typeof BasePopover.Popup> & {
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
}): React.JSX.Element {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner align={align} side={side} sideOffset={6} className="z-50 outline-none">
        <BasePopover.Popup
          className={cn(
            'rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none transition-all duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            className
          )}
          {...props}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
