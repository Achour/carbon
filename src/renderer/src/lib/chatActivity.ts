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
 * Which state matters most, without building the label: user action wins over
 * background activity, which wins over generic foreground work. The allocation-
 * free half of `chatActivity`, for selectors that run on every streamed delta
 * and only branch on the kind.
 */
export function chatActivityKind(
  status: ChatStatus | undefined,
  jobs: BackgroundJob[] | undefined,
  requests: PermissionRequestPayload[] | undefined
): ChatActivity['kind'] {
  if (status === 'waiting-permission' || requests?.length) return 'needs-input'
  if (jobs?.length) return 'background'
  if (status === 'starting' || status === 'streaming') return 'working'
  return 'idle'
}

/**
 * Reduce the provider-neutral live signals to the one state that matters most
 * in the sidebar, with the words for it.
 */
export function chatActivity(
  status: ChatStatus | undefined,
  jobs: BackgroundJob[] | undefined,
  requests: PermissionRequestPayload[] | undefined
): ChatActivity {
  switch (chatActivityKind(status, jobs, requests)) {
    case 'needs-input':
      return {
        kind: 'needs-input',
        label: requests?.length ? inputLabel(requests) : 'Needs your input'
      }
    case 'background':
      return { kind: 'background', label: 'Background jobs running', count: jobs?.length ?? 0 }
    case 'working':
      return { kind: 'working', label: 'Working' }
    default:
      return { kind: 'idle', label: 'Idle' }
  }
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
