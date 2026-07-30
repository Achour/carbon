import type {
  BackgroundJob,
  ChatStatus,
  PermissionRequestPayload
} from '@shared/types'

export type ChatActivity =
  | { kind: 'idle'; label: 'Idle' }
  | { kind: 'working'; label: string }
  | { kind: 'needs-input'; label: string }
  | { kind: 'background'; label: string; count: number }

function inputLabel(requests: PermissionRequestPayload[]): string {
  if (requests.some((request) => request.toolName === 'AskUserQuestion')) {
    return 'Needs your answer'
  }
  if (requests.some((request) => request.toolName === 'ExitPlanMode')) {
    return 'Plan ready for review'
  }
  return requests.length > 1 ? `${requests.length} requests need your input` : 'Needs your permission'
}

/**
 * Reduce the provider-neutral live signals to the one state that matters most
 * in the sidebar. User action wins over background activity, which wins over
 * generic foreground work.
 */
export function chatActivity(
  status: ChatStatus | undefined,
  jobs: BackgroundJob[] | undefined,
  requests: PermissionRequestPayload[] | undefined
): ChatActivity {
  if (status === 'waiting-permission' || requests?.length) {
    return {
      kind: 'needs-input',
      label: requests?.length ? inputLabel(requests) : 'Needs your input'
    }
  }

  if (jobs?.length) {
    return {
      kind: 'background',
      label: 'Background jobs running',
      count: jobs.length
    }
  }

  if (status === 'starting' || status === 'streaming') {
    return { kind: 'working', label: 'Working' }
  }

  return { kind: 'idle', label: 'Idle' }
}

/** Highest-priority activity for a collapsed project row. */
export function projectActivity(activities: ChatActivity[]): ChatActivity {
  const needingInput = activities.filter((activity) => activity.kind === 'needs-input')
  if (needingInput.length) {
    return {
      kind: 'needs-input',
      label:
        needingInput.length === 1
          ? '1 chat needs your input'
          : `${needingInput.length} chats need your input`
    }
  }

  const backgroundCount = activities.reduce(
    (total, activity) => total + (activity.kind === 'background' ? activity.count : 0),
    0
  )
  if (backgroundCount) {
    return {
      kind: 'background',
      label: 'Background jobs running',
      count: backgroundCount
    }
  }

  return activities.some((activity) => activity.kind === 'working')
    ? { kind: 'working', label: 'A chat is working' }
    : { kind: 'idle', label: 'Idle' }
}
