/**
 * The chat column — one definition for the transcript and the composer.
 *
 * A chat has exactly one reading column, and two kinds of thing sit in it:
 *
 * - **Prose** (an assistant reply, a code block, a table) starts *on* the
 *   column edge.
 * - **Framed** objects (the user's prompt, the composer and the pill rows
 *   above it) bleed `BLEED` outside it and carry the same amount as internal
 *   padding, so their own text lands back on the column while their border
 *   sits a little proud of it.
 *
 * That is Cursor's model, and it only reads as deliberate while *every* frame
 * bleeds by the same amount. It was written out twice — the prompt box bled and
 * the composer did not — which left three left edges within one chat: the
 * composer's border, the prompt's border 4px inside it, and the prose 14px
 * inside that.
 *
 * The two spellings exist because the sites differ: the prompt box is one
 * element, so it takes the classes; the composer stack is several rows sharing
 * one bleed, so its wrapper takes them.
 */
export const CHAT_BLEED = '-mx-3.5 w-[calc(100%+1.75rem)]'

/** The padding a bleeding frame needs for its text to land on the column. */
export const CHAT_BLEED_PAD = 'px-3.5'

/**
 * The frame itself — fill, radius, border and shadow — shared by the composer
 * and the user's prompt.
 *
 * They are the same kind of object: the box the user's own words sit in,
 * before and after sending. Spelled twice they drifted into two surfaces on
 * one screen — the composer solid on `--card` with a 16px radius and a
 * shadow, the prompt a 40%-opacity `--secondary` at 12px and flat — so a sent
 * message read as a fainter, smaller copy of the thing that sent it rather
 * than as the same box scrolled up. One definition is what keeps the answer
 * to "what does a prompt look like" from depending on which file you read.
 *
 * The composer adds only what is true of it alone: its focus ring, and the
 * border it takes on while a file is dragged over it.
 */
export const CHAT_FRAME =
  'rounded-2xl border border-border bg-card shadow-lg shadow-black/5 dark:shadow-black/20'
