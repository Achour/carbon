import type { Attachment, PendingSteer } from '../shared/types.ts'

export interface HeldSteer {
  id: string
  text: string
  attachments: Attachment[]
}

/**
 * Steers a Stop cut off, as the one message that goes next. One rather than a turn
 * each, because `send` writes its row at once and the turn runs later: two would read
 * as both prompts and then both answers, with the second's changes card claiming the
 * first's work. Said in the same breath, they are answered in one.
 */
export function mergeSteers(steers: HeldSteer[]): Pick<HeldSteer, 'text' | 'attachments'> | undefined {
  if (!steers.length) return undefined
  return {
    text: steers
      .map((steer) => steer.text)
      .filter(Boolean)
      .join('\n\n'),
    attachments: steers.flatMap((steer) => steer.attachments)
  }
}

/**
 * What a session has handed to its running turn and the agent has not picked up.
 *
 * A steered message is not written to the transcript when it is sent. It lands
 * where the agent actually read it, which is the only place a reader can make
 * sense of it: writing it at send time would leave the reply still streaming
 * growing above a message it never saw. Until then it lives here, and the
 * composer draws it from the list this publishes.
 */
export class PendingSteers {
  private readonly held = new Map<string, HeldSteer>()
  private readonly publish: (steers: PendingSteer[]) => void
  private readonly cancellable: boolean

  constructor(publish: (steers: PendingSteer[]) => void, cancellable: boolean) {
    this.publish = publish
    this.cancellable = cancellable
  }

  get size(): number {
    return this.held.size
  }

  ids(): string[] {
    return [...this.held.keys()]
  }

  add(steer: HeldSteer): void {
    this.held.set(steer.id, steer)
    this.announce()
  }

  /** Remove one, say so, and hand it over. Undefined if it was never here. */
  take(id: string): HeldSteer | undefined {
    const steer = this.held.get(id)
    if (!steer) return undefined
    this.held.delete(id)
    this.announce()
    return steer
  }

  /** Every one still held, oldest first, for landing together. */
  takeAll(): HeldSteer[] {
    return this.takeExcept([])
  }

  /** Every one not named as still on its way, oldest first. */
  takeExcept(survivors: readonly string[]): HeldSteer[] {
    const gone = [...this.held.values()].filter((steer) => !survivors.includes(steer.id))
    if (!gone.length) return gone
    for (const steer of gone) this.held.delete(steer.id)
    this.announce()
    return gone
  }

  private announce(): void {
    this.publish(
      [...this.held.values()].map(({ id, text, attachments }) => ({
        id,
        text,
        ...(attachments.length ? { attachmentNames: attachments.map((a) => a.name) } : {}),
        cancellable: this.cancellable
      }))
    )
  }
}
