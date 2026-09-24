import { cn } from '@/lib/utils'

/** The eight outer cells of a 3×3 grid, clockwise from the top-left. */
const RING: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [2, 0],
  [2, 1],
  [2, 2],
  [1, 2],
  [0, 2],
  [0, 1]
]

/** Must match `.dot-chase` in `index.css`. */
const PERIOD_MS = 960

/**
 * The app's loading indicator: a lit dot chasing clockwise round a square of
 * dots, a fading tail behind it.
 *
 * Every dot runs the same stepped `dot-chase` fade, offset by one eighth of the
 * lap per place on the ring, so the head is whichever dot's cycle has just
 * restarted and all eight change on the same tick. A negative delay starts each
 * one mid-cycle — the first frame already shows the tail rather than the dots
 * lighting up in turn from dark.
 */
export function DotSpinner({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden={props['aria-label'] ? undefined : true}
      role={props['aria-label'] ? 'img' : undefined}
      className={cn('size-3', className)}
      {...props}
    >
      {RING.map(([x, y], i) => (
        <rect
          key={i}
          x={x * 4.5 + 0.25}
          y={y * 4.5 + 0.25}
          width={2.5}
          height={2.5}
          rx={0.6}
          fill="currentColor"
          className="dot-chase"
          style={{ animationDelay: `${(i * PERIOD_MS) / RING.length - PERIOD_MS}ms` }}
        />
      ))}
    </svg>
  )
}
