import { ArrowDownToLine, X } from 'lucide-react'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { WithTooltip } from '@/components/ui/tooltip'

/**
 * "A new version is out" — the whole update story for an unsigned build.
 *
 * There is no in-place install to offer (see `main/updates.ts`), so the banner's
 * only job is to name the version and hand off to the download. It sits just
 * above the sidebar footer: present enough to be noticed on the next glance at
 * the chat list, quiet enough not to interrupt a turn.
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
    </div>
  )
}
