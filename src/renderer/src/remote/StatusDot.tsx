import type { ChatStatus } from '@shared/types'

export function StatusDot({
  status,
  asking
}: {
  status: ChatStatus | undefined
  asking: boolean
}): React.JSX.Element {
  const kind = asking || status === 'waiting-permission' ? 'asking' : status && status !== 'idle' ? 'working' : 'idle'
  return <span className={`dot ${kind}`} aria-label={kind === 'idle' ? 'Idle' : kind === 'asking' ? 'Waiting for you' : 'Working'} />
}
