import * as React from 'react'
import { cn } from '@/lib/utils'
import { classifyInk, inkDark, inkKnown } from '@/lib/faviconInk'
import { projectHue, projectInitials } from '@/lib/projectIdentity'

/**
 * A project's mark: its own icon where it has one, two letters where it doesn't.
 *
 * **The icon is preferred because it is the project's answer, not ours.** A
 * repo that ships a favicon or an app icon has already decided what it looks
 * like, and any generated disc beside it would be the app inventing a second
 * identity for something that had one. The initials are the honest fallback,
 * not a style choice — most folders genuinely have no icon, and a row of
 * identical grey squares would tell the reader nothing.
 *
 * The disc follows `ProviderAvatar`'s idiom — the glyph in its own colour on a
 * weak tint of it — so a column of project marks and a column of provider marks
 * read as the same kind of thing. The hue is the only thing that varies per
 * project; its lightness and chroma come from `--project-ink-*`, which is
 * re-stepped for dark mode, so one number per project covers both grounds.
 *
 * **An icon is measured before it is drawn.** A favicon is made for the site's
 * own background, and a dark monochrome glyph on transparency — the house style
 * for developer projects, and what `build/icon.svg` is here — is an invisible
 * mark on Carbon's dark sheet. `classifyInk` is the same verdict the transcript's
 * link marks use, keyed here on the project root so the answer is computed once
 * per project rather than once per render.
 */
/**
 * The four sizes a project mark is drawn at, each one box + radius + initials
 * together.
 *
 * They move as a unit or not at all: the initials are sized off the box, so a
 * call site that overrode `size-7` alone kept 11px letters inside a 16px disc.
 * The radius tracks it too — a 4px corner on a 44px tile reads as a photo, and
 * a 12px corner on a 14px one reads as a circle.
 */
const SIZES = {
  /** Inline on a meta line, beside 11px text and the 12px branch glyph. */
  xs: 'size-3.5 rounded-[4px] text-[7px]',
  /** A row's leading glyph: the sidebar's project rows, the filter, the menus. */
  sm: 'size-4 rounded-[5px] text-[8px]',
  /** A list row you are meant to pick from — Settings → Projects' list. */
  md: 'size-6 rounded-md text-[10px]',
  /** The subject of the page it heads. */
  lg: 'size-11 rounded-xl text-[15px]'
} as const

export type ProjectAvatarSize = keyof typeof SIZES

export function ProjectAvatar({
  root,
  name,
  icon,
  size = 'md',
  className,
  dimmed,
  ...rest
}: {
  /** The project root — the hue's key, and the ink verdict's. */
  root: string
  /** Display name: the letters, so a renamed project relabels its disc. */
  name: string
  /** `data:` URI found in the project, or null for the initials fallback. */
  icon: string | null
  size?: ProjectAvatarSize
  className?: string
  /**
   * A project whose folder is gone. The mark is dimmed but keeps its hue: the
   * colour *is* the identity, and graying it out makes the one row the reader
   * most needs to recognize the hardest one to. The state is said in words on
   * the row beside it, which is where a state belongs.
   */
  dimmed?: boolean
  /**
   * **Everything else lands on the outer element, and that is what lets this be
   * a tooltip trigger.** Base UI's `Tooltip.Trigger render={child}` clones the
   * child with its handlers, its id and its ref merged in as props — so a
   * component that names its props and drops the rest is handed them and
   * throws them away, leaving a trigger that anchors nothing and never opens.
   * Nothing renders differently, which is why it can only be caught by looking
   * for `data-base-ui-tooltip-trigger` on the element that should have it.
   */
} & Omit<React.ComponentProps<'span'>, 'children'>): React.JSX.Element {
  const [, bump] = React.useReducer((n: number) => n + 1, 0)

  React.useEffect(() => {
    if (!icon || inkKnown(root)) return
    let alive = true
    void classifyInk(root, icon).then(() => {
      if (alive) bump()
    })
    return () => {
      alive = false
    }
  }, [root, icon])

  if (icon) {
    // **The icon is the whole mark, not a picture of one.** It used to sit at
    // 70% inside a bordered `bg-card` tile, which gave a project that ships an
    // icon a *smaller* mark than one falling back to initials — the two sat in
    // the same column at visibly different weights, and the frame read as a
    // second thing rather than as the mark's ground. A favicon already carries
    // whatever ground its author wanted; ours was the app inventing one.
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden',
          SIZES[size],
          dimmed && 'opacity-50',
          className
        )}
        {...rest}
      >
        <img
          src={icon}
          alt=""
          aria-hidden
          className={cn('size-full object-contain', inkDark(root) && 'dark:invert')}
        />
      </span>
    )
  }

  const color = `oklch(var(--project-ink-l) var(--project-ink-c) ${projectHue(root)})`
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center font-semibold tracking-tight tabular-nums',
        SIZES[size],
        dimmed && 'opacity-50',
        className
      )}
      style={{ color, background: `color-mix(in oklab, ${color} 16%, transparent)` }}
      aria-hidden
      {...rest}
    >
      {projectInitials(name)}
    </span>
  )
}
