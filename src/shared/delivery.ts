/**
 * How a delegate's outcome reads when it is delivered to the parent, and how
 * the renderer recognizes one. A delivery is a labelled user message the app
 * wrote (`flushDeliveries`), carrying no flag of its own, so its opening words
 * are the mark: main writes them from these constants and the turn rail reads
 * them, which keeps the two from drifting.
 *
 * Dependency-free so `node --test` runs it straight off the `.ts`.
 */

/** Every single outcome opens with this (`deliveryText`). */
export const DELIVERY_OPENER = 'Your agent '

/** Several outcomes batched into one delivery (`pendingDeliveriesContext`). */
export const DELIVERIES_OPENER = 'Agents from this conversation finished while Carbon could not report them:'

/**
 * A delegate reporting back rather than the user asking. The label is required:
 * a delivery always has one, and a prompt the user typed never does, so typing
 * the same words is not mistaken for one.
 */
export function isDelivery(message: { text: string; label?: string }): boolean {
  return (
    !!message.label &&
    (message.text.startsWith(DELIVERY_OPENER) || message.text.startsWith(DELIVERIES_OPENER))
  )
}
