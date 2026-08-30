const SERIES = [12, 18, 15, 24, 31, 28, 44, 39, 52, 61, 58, 74]

/**
 * A plain <svg> with preserveAspectRatio="none" plus vector-effect, so it
 * stretches to any card width without thickening the stroke.
 */
export function Sparkline(): JSX.Element {
  const max = Math.max(...SERIES)
  const points = SERIES.map((v, i) => `${(i / (SERIES.length - 1)) * 100},${100 - (v / max) * 100}`)

  return (
    <svg className="spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <polyline points={points.join(' ')} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
