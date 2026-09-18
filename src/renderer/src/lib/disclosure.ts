/**
 * The one definition of how a disclosure opens and closes.
 *
 * Five panels were carrying near-identical copies of this string — an activity
 * row's body, a run's expanded calls, a permission prompt's details, the task
 * card, the turn's changed files — and all five animated **height only**. With
 * `overflow-hidden` that reads as a wipe: the content is cropped away a pixel
 * row at a time, at full opacity right up to the moment it is gone. It is
 * motion without a fade, which is exactly the thing a reader describes as
 * content *disappearing* rather than closing.
 *
 * Opacity travels with the height, in **both** directions, so opening dissolves
 * in as it grows and collapsing fades as it shrinks. `data-starting-style` and
 * `data-ending-style` are Base UI's enter/exit hooks; naming opacity in both is
 * what makes the pair symmetric, and a collapse that fades is the half that was
 * missing entirely.
 *
 * It is one constant rather than five strings because five copies of a
 * transition are five chances for two disclosures to disagree about how long
 * closing takes — which the reader sees as the app being inconsistent with
 * itself, without ever being able to name why.
 */
export const DISCLOSURE_PANEL =
  'h-[var(--collapsible-panel-height)] overflow-hidden opacity-100 transition-[height,opacity] duration-200 ease-out data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[starting-style]:h-0 data-[starting-style]:opacity-0'
