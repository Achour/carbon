import * as React from 'react'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { UsageLookupContext, UsageReportView } from '@/components/UsageStats'
import { useRemote } from './state'
import { Header } from './App'

const NO_NAMES: Record<string, string> = {}

/**
 * The desktop's Usage page on the phone: what was spent, where, over the last
 * 24 hours to 90 days. It is the desktop's own view (`UsageReportView`) in its
 * touch shape, fed over the relay (`usage:report`), so the two screens cannot
 * disagree about a number. Projects wear the marks the sidebar already has;
 * the Mac's custom project names stay there, so a project reads as its folder.
 */
export function UsageScreen(): React.JSX.Element {
  const report = useRemote((s) => s.usageReport)
  const loading = useRemote((s) => s.usageReportLoading)
  const range = useRemote((s) => s.usageDays)
  const load = useRemote((s) => s.loadUsageReport)
  const connection = useRemote((s) => s.connection)
  const icons = useRemote((s) => s.icons)
  const lookup = React.useMemo(() => ({ names: NO_NAMES, icons }), [icons])

  // Reread on every visit, unforced: main answers from its per-file cache, so
  // only logs written since the last scan are read.
  React.useEffect(() => {
    if (connection === 'live') void load()
  }, [connection, load])

  return (
    <div className="flex h-full flex-col">
      <Header title="Usage" />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
        {!report ? (
          <div className="flex h-full items-center justify-center gap-2.5 text-[14px] text-muted-foreground">
            <DotSpinner className="size-4" />
            Reading session logs…
          </div>
        ) : (
          <UsageLookupContext.Provider value={lookup}>
            <UsageReportView touch report={report} loading={loading} range={range} onLoad={(d, r) => void load(d, r)} />
          </UsageLookupContext.Provider>
        )}
      </div>
    </div>
  )
}
