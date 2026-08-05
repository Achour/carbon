import * as React from 'react'
import { ArrowDownToLine, Check, Copy, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'

/**
 * Updating a build you compiled yourself. The recommended install is
 * `npm run install-app` from a clone — precisely because a locally built app
 * never carries the download quarantine flag Gatekeeper reacts to — so handing
 * those users the .dmg would walk them back into the prompt they avoided.
 */
export const UPDATE_FROM_SOURCE = 'git pull && npm install && npm run install-app'

/**
 * Click-to-copy for the from-source command.
 *
 * Shown next to the download rather than instead of it: nothing in the app
 * records how it was installed, so the honest move is to offer both routes and
 * let the reader recognize their own.
 */
export function CopyUpdateCommand({
  className,
  /**
   * The sidebar is too narrow for the command, and a version truncated
   * mid-word reads worse than a label — so there it names the action instead.
   */
  label
}: {
  className?: string
  label?: string
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(UPDATE_FROM_SOURCE)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={
        'group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left ' +
        'text-[10px] text-muted-foreground/80 transition-colors hover:bg-accent/60 ' +
        'hover:text-foreground ' +
        (className ?? '')
      }
      aria-label="Copy the update-from-source command"
    >
      {copied ? (
        <Check className="size-3 shrink-0 text-primary" />
      ) : (
        <Copy className="size-3 shrink-0 opacity-60" />
      )}
      <code className={cn('truncate', label ? 'font-sans' : 'font-mono')}>
        {copied ? 'Copied' : (label ?? UPDATE_FROM_SOURCE)}
      </code>
    </button>
  )
}

/**
 * "A new version is out" — the whole update story for an unsigned build.
 *
 * There is no in-place install to offer (see `main/updates.ts`), so the banner's
 * only job is to name the version and point at the two ways to get it. It sits
 * just above the sidebar footer: present enough to be noticed on the next glance
 * at the chat list, quiet enough not to interrupt a turn.
 */
export function UpdateBanner(): React.ReactElement | null {
  const update = useApp((s) => s.update)
  const dismissed = useApp((s) => s.updateDismissed)
  const dismissUpdate = useApp((s) => s.dismissUpdate)

  if (!update || dismissed === update.version) return null

  // No matching asset (a release that only shipped other platforms) still has
  // somewhere useful to go — the release page lists everything.
  const href = update.downloadUrl ?? update.releaseUrl
  if (!href) return null

  return (
    <div className="mx-2 mb-2 shrink-0 rounded-lg border border-border bg-accent/40 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-sidebar-foreground">
            Version {update.version} available
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            You&rsquo;re on {window.api.appVersion}
          </div>
        </div>
        <WithTooltip label="Dismiss until the next release">
          <Button
            size="icon-sm"
            variant="ghost"
            className="-mr-1 -mt-0.5"
            onClick={dismissUpdate}
            aria-label="Dismiss update notice"
          >
            <X />
          </Button>
        </WithTooltip>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="mt-2 w-full"
        onClick={() => void window.api.openExternal(href)}
      >
        <ArrowDownToLine />
        {update.downloadUrl ? 'Download' : 'View release'}
      </Button>
      <div className="mt-1.5 border-t border-border/60 pt-1">
        <div className="px-1.5 pb-0.5 text-[10px] text-muted-foreground/70">Built from source?</div>
        <CopyUpdateCommand label="Copy update command" />
      </div>
    </div>
  )
}
