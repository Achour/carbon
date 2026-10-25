import * as React from 'react'
import { PanelLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'

/**
 * The title bar of a full-window page (Usage, Pull requests, Scheduled): the
 * page's name at the left, its actions at the right.
 *
 * With the sidebar collapsed the page's left edge is the window's, where macOS
 * draws the traffic lights, so the bar steps in past them and offers the
 * sidebar back, exactly as a chat's header does (`ThreadView`). Each page used
 * to draw its own bar with a plain `px-4`, and every one put its title under
 * the window's buttons the moment the sidebar was hidden.
 */
export function PageHeader({
  title,
  children
}: {
  title: string
  /** The page's actions, right-aligned. */
  children?: React.ReactNode
}): React.JSX.Element {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  return (
    <header
      className={cn(
        'drag flex h-[38px] shrink-0 items-center gap-2 border-b border-border px-4',
        !sidebarOpen && 'pl-[84px]'
      )}
    >
      {!sidebarOpen && (
        <WithTooltip label="Show sidebar  ⌘B">
          <Button
            size="icon-sm"
            variant="ghost"
            className="no-drag"
            onClick={toggleSidebar}
            aria-label="Show sidebar"
          >
            <PanelLeft />
          </Button>
        </WithTooltip>
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </header>
  )
}
