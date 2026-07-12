import * as React from 'react'
import { cn } from '@/lib/utils'

/** A keyboard-shortcut hint, shadcn/Base-UI style. */
function Kbd({ className, ...props }: React.ComponentProps<'kbd'>): React.JSX.Element {
  return (
    <kbd
      className={cn(
        'pointer-events-none inline-flex h-5 w-fit min-w-5 select-none items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

/** Groups multiple <Kbd> chips (e.g. ⌘ then K) with consistent spacing. */
function KbdGroup({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('inline-flex items-center gap-1', className)} {...props} />
}

export { Kbd, KbdGroup }
