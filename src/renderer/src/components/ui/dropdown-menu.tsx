import * as React from 'react'
import { Menu } from '@base-ui/react/menu'
import { cn } from '@/lib/utils'

const DropdownMenu = Menu.Root
const DropdownMenuTrigger = Menu.Trigger

function DropdownMenuContent({
  className,
  align = 'start',
  side = 'bottom',
  children,
  ...props
}: React.ComponentProps<typeof Menu.Popup> & {
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
}): React.JSX.Element {
  return (
    <Menu.Portal>
      <Menu.Positioner align={align} side={side} sideOffset={5} className="z-50 outline-none">
        <Menu.Popup
          className={cn(
            'min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-all duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            className
          )}
          {...props}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  )
}

function DropdownMenuItem({
  className,
  destructive,
  ...props
}: React.ComponentProps<typeof Menu.Item> & { destructive?: boolean }): React.JSX.Element {
  return (
    <Menu.Item
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent [&_svg]:size-3.5 [&_svg]:text-muted-foreground',
        destructive &&
          'text-destructive data-[highlighted]:bg-destructive/10 [&_svg]:text-destructive',
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Menu.Separator>): React.JSX.Element {
  return <Menu.Separator className={cn('my-1 h-px bg-border', className)} {...props} />
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
}
