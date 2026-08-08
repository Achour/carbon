import * as React from 'react'
import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import { cn } from '@/lib/utils'

const ContextMenu = BaseContextMenu.Root
const ContextMenuTrigger = BaseContextMenu.Trigger

function ContextMenuContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Popup>): React.JSX.Element {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className="z-50 outline-none">
        <BaseContextMenu.Popup
          className={cn(
            'min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-all duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            className
          )}
          {...props}
        >
          {children}
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  )
}

function ContextMenuItem({
  className,
  destructive,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Item> & {
  destructive?: boolean
}): React.JSX.Element {
  return (
    <BaseContextMenu.Item
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

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Separator>): React.JSX.Element {
  return <BaseContextMenu.Separator className={cn('my-1 h-px bg-border', className)} {...props} />
}

/**
 * A run of items under a shared heading. Required around `ContextMenuLabel` —
 * Base UI's `GroupLabel` reads a context this provides and *throws* without it,
 * which in a renderer means a blank window rather than a missing label.
 */
function ContextMenuGroup(
  props: React.ComponentProps<typeof BaseContextMenu.Group>
): React.JSX.Element {
  return <BaseContextMenu.Group {...props} />
}

/** A heading over a group of items — says what the items below it act on. */
function ContextMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.GroupLabel>): React.JSX.Element {
  return (
    <BaseContextMenu.GroupLabel
      className={cn('truncate px-2 py-1 text-[11px] text-muted-foreground/70', className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator
}
