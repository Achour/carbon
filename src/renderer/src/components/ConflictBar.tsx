import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { editorNotice } from '@/lib/utils'

/**
 * "This file changed on disk while you were editing it."
 *
 * This is the collision an ordinary editor mostly doesn't have and Carbon
 * always will: the agent writes the same files the user has open, and a turn
 * ends by refreshing them. Neither side can be assumed to win — the buffer may
 * be a half-finished thought the user wants to keep, or a stale copy of a file
 * the agent just rewrote — so the bar states the fact and offers both, which is
 * the only honest option when the app genuinely cannot tell.
 */
export function ConflictBar({ path }: { path: string }): React.JSX.Element | null {
  const conflict = useApp((s) => s.fileConflicts[path])
  const resolve = useApp((s) => s.resolveConflict)
  if (conflict === undefined) return null
  return (
    <div className={editorNotice}>
      <AlertTriangle className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        Changed on disk since you started editing — your unsaved edits are still here.
      </span>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => void resolve(path, 'reload')}>
        Discard mine
      </Button>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => void resolve(path, 'overwrite')}>
        Overwrite disk
      </Button>
    </div>
  )
}
