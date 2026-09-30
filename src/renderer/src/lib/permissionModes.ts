import {
  ClipboardList,
  FileCheck2,
  PencilLine,
  ShieldOff,
  ShieldQuestion,
  WandSparkles,
  type LucideIcon
} from 'lucide-react'
import { PERMISSION_MODES, type PermissionModeId, type Provider } from '@shared/types'

// Codex App Server exposes native command, file and additional-permission
// approvals. Plan and Full Access remain non-interactive; Auto asks App Server's
// reviewer to classify approval requests before escalating them to the user.
const CODEX_PERMISSION_MODES: { id: PermissionModeId; label: string; description: string }[] = [
  { id: 'plan', label: 'Plan mode', description: 'Investigates and plans without making changes' },
  { id: 'default', label: 'Ask to approve', description: 'Prompts when work needs extra access' },
  { id: 'acceptEdits', label: 'Accept edits', description: 'Edits in the project; asks on escalation' },
  { id: 'auto', label: 'Auto', description: 'Codex reviews approval requests before escalating' },
  { id: 'bypassPermissions', label: 'Full access', description: 'No sandbox — use with care' }
]

// Grok has no Accept-edits: its CLI treats `acceptEdits` as a Claude-compat
// alias of ask, so offering it would name a mode the session never enters. The
// rest map onto real baselines — `_meta.yoloMode`, `_meta.autoMode`, and the
// plan flag (see `grokPermissionMode`).
const GROK_PERMISSION_MODES: { id: PermissionModeId; label: string; description: string }[] = [
  { id: 'plan', label: 'Plan mode', description: 'Explores and writes a plan before building' },
  { id: 'default', label: 'Ask to approve', description: 'Prompts before sensitive actions' },
  // "Blocks" rather than "asks": in a non-interactive client a call the check
  // refuses fails and is reported to the model — it does not escalate to a
  // prompt the way Claude's Auto does.
  { id: 'auto', label: 'Auto', description: 'A safety check approves or blocks each action' },
  // Not Claude's "Never asks": Grok still applies deny rules, hooks and some
  // shell ask rules under always-approve.
  { id: 'bypassPermissions', label: 'Full access', description: 'Skips prompts — deny rules still apply' }
]

/**
 * Which permission modes each backend actually implements. A menu built from
 * the wrong provider's list offers modes that silently degrade — Grok served
 * Claude's list would advertise Accept edits and get ask.
 */
export const PROVIDER_PERMISSION_MODES: Record<
  Provider,
  { id: PermissionModeId; label: string; description: string }[]
> = {
  claude: PERMISSION_MODES,
  codex: CODEX_PERMISSION_MODES,
  grok: GROK_PERMISSION_MODES
}

export function codexPermissionValue(mode: PermissionModeId): PermissionModeId {
  return mode
}

type PermissionAppearance = {
  Icon: LucideIcon
  iconClassName: string
  triggerClassName: string
}

/** A consistent icon and semantic accent for permission modes across providers. */
export function permissionAppearance(
  mode: PermissionModeId,
  isCodex: boolean
): PermissionAppearance {
  switch (mode) {
    case 'plan':
      return {
        Icon: ClipboardList,
        iconClassName: 'text-sky-600 dark:text-sky-400',
        triggerClassName:
          'text-sky-700 hover:text-sky-700 data-[popup-open]:text-sky-700 dark:text-sky-400 dark:hover:text-sky-400 dark:data-[popup-open]:text-sky-400'
      }
    case 'acceptEdits':
      return {
        Icon: FileCheck2,
        iconClassName: 'text-emerald-600 dark:text-emerald-400',
        triggerClassName:
          'text-emerald-700 hover:text-emerald-700 data-[popup-open]:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-400 dark:data-[popup-open]:text-emerald-400'
      }
    case 'auto':
      return {
        Icon: WandSparkles,
        iconClassName: 'text-violet-600 dark:text-violet-400',
        triggerClassName:
          'text-violet-700 hover:text-violet-700 data-[popup-open]:text-violet-700 dark:text-violet-400 dark:hover:text-violet-400 dark:data-[popup-open]:text-violet-400'
      }
    case 'bypassPermissions':
      return {
        Icon: ShieldOff,
        iconClassName: 'text-amber-600 dark:text-amber-400',
        triggerClassName:
          'text-amber-700 hover:text-amber-700 data-[popup-open]:text-amber-700 dark:text-amber-400 dark:hover:text-amber-400 dark:data-[popup-open]:text-amber-400'
      }
    default:
      return {
        Icon: isCodex ? PencilLine : ShieldQuestion,
        iconClassName: 'text-muted-foreground',
        triggerClassName: ''
      }
  }
}
