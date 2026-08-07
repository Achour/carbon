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
 * The cask upgrades in place and clears the quarantine flag itself, so for a
 * brew install this is the entire update story — no download, no Gatekeeper.
 *
 * `brew update &&` is not optional, and leaving it off is a bug we shipped
 * once: Homebrew only re-pulls a tap when its last auto-update was more than
 * `HOMEBREW_AUTO_UPDATE_SECS` ago (a day, by default), so a bare `brew upgrade`
 * reads a stale local clone of the tap and answers "the latest version is
 * already installed". This banner has just read the real answer straight from
 * the releases API, so that reply is not merely unhelpful — it directly
 * contradicts the thing the user is looking at.
 */
export const UPDATE_VIA_HOMEBREW = 'brew update && brew upgrade --cask carbon'

/**
 * Click-to-copy for a one-line update command.
 *
 * When main can tell the app came from Homebrew this replaces the download
 * outright; otherwise it sits *next to* one, because nothing distinguishes a
 * build made from a clone from a downloaded `.dmg` — so the honest move is to
 * offer both routes and let the reader recognize their own.
 */
export function CopyUpdateCommand({
  className,
  command = UPDATE_FROM_SOURCE,
  /**
   * The sidebar is too narrow for the command, and a version truncated
   * mid-word reads worse than a label — so there it names the action instead.
   */
  label
}: {
  className?: string
  command?: string
  label?: string
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      // `cn` rather than concatenation so a caller's `text-[11px]` actually
      // beats the default size instead of racing it in the stylesheet.
      className={cn(
        'group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left',
        'text-[10px] text-muted-foreground/80 transition-colors hover:bg-accent/60',
        'hover:text-foreground',
        className
      )}
      aria-label="Copy the update-from-source command"
    >
      {copied ? (
        <Check className="size-3 shrink-0 text-primary" />
      ) : (
        <Copy className="size-3 shrink-0 opacity-60" />
      )}
      <code className={cn('truncate', label ? 'font-sans' : 'font-mono')}>
        {copied ? 'Copied' : (label ?? command)}
      </code>
    </button>
  )
}

/**
 * "A new version is out" — the whole update story for an unsigned build.
 *
 * The app can't install the update itself (see `main/updates.ts`), so the
 * banner's job is to name the version and hand over the one command or link that
 * finishes the job. It sits just above the sidebar footer: present enough to be
 * noticed on the next glance at the chat list, quiet enough not to interrupt a
 * turn.
 */
export function UpdateBanner(): React.ReactElement | null {
  const update = useApp((s) => s.update)
  const dismissed = useApp((s) => s.updateDismissed)
  const dismissUpdate = useApp((s) => s.dismissUpdate)
  const brew = window.api.installedViaHomebrew

  if (!update || dismissed === update.version) return null

  // No matching asset (a release that only shipped other platforms) still has
  // somewhere useful to go — the release page lists everything. A brew install
  // needs neither link, so an assetless release still has something to say to it.
  const href = update.downloadUrl ?? update.releaseUrl
  if (!brew && !href) return null

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
      {brew ? (
        // Homebrew upgrades in place, so the command *replaces* the download
        // rather than sitting under it as an alternative — offering the .dmg
        // here would strand brew's records on a version no longer installed.
        <div className="mt-2">
          {/* Short enough to hold one line at the sidebar's width — the full
              sentence lives in Settings, where there's room for it. */}
          <div className="px-1.5 pb-0.5 text-[10px] text-muted-foreground/70">
            Upgrade with Homebrew:
          </div>
          {/* Named rather than shown: the two-part command is too wide for the
              sidebar, and a command truncated mid-flag reads as if that's all
              of it. Settings has the room and prints it in full. */}
          <CopyUpdateCommand
            command={UPDATE_VIA_HOMEBREW}
            label="Copy upgrade command"
            className="border border-border/70 bg-background/50 py-1.5 text-[11px]"
          />
        </div>
      ) : (
        <>
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
            <div className="px-1.5 pb-0.5 text-[10px] text-muted-foreground/70">
              Built from source?
            </div>
            <CopyUpdateCommand label="Copy update command" />
          </div>
        </>
      )}
    </div>
  )
}
