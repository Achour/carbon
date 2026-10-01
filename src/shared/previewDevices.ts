/**
 * The preview's viewport presets, shared by the toolbar's device menu and the
 * agent's `preview_resize` so both name the same sizes.
 *
 * Sizes are CSS pixels in portrait, the way Chrome DevTools lists them; a
 * rotated viewport swaps them. `mobile` is what turns on touch, the mobile
 * user agent and the meta-viewport behaviour — a phone-sized desktop window is
 * a different thing from a phone, and a responsive bug is often in the gap.
 */
export interface PreviewDevice {
  id: string
  label: string
  width: number
  height: number
  /** Device pixel ratio the page sees. */
  dpr: number
  mobile: boolean
  /** The mobile user agent it sends; absent for a desktop size. */
  os?: 'ios' | 'android'
  group: 'phone' | 'tablet' | 'desktop'
}

export const PREVIEW_DEVICES: readonly PreviewDevice[] = [
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, dpr: 2, mobile: true, os: 'ios', group: 'phone' },
  { id: 'iphone-15', label: 'iPhone 15', width: 393, height: 852, dpr: 3, mobile: true, os: 'ios', group: 'phone' },
  { id: 'iphone-15-pro-max', label: 'iPhone 15 Pro Max', width: 430, height: 932, dpr: 3, mobile: true, os: 'ios', group: 'phone' },
  { id: 'pixel-8', label: 'Pixel 8', width: 412, height: 915, dpr: 2.625, mobile: true, os: 'android', group: 'phone' },
  { id: 'galaxy-s24', label: 'Galaxy S24', width: 360, height: 780, dpr: 3, mobile: true, os: 'android', group: 'phone' },
  { id: 'ipad-mini', label: 'iPad Mini', width: 768, height: 1024, dpr: 2, mobile: true, os: 'ios', group: 'tablet' },
  { id: 'ipad-air', label: 'iPad Air', width: 820, height: 1180, dpr: 2, mobile: true, os: 'ios', group: 'tablet' },
  { id: 'ipad-pro', label: 'iPad Pro 12.9"', width: 1024, height: 1366, dpr: 2, mobile: true, os: 'ios', group: 'tablet' },
  { id: 'laptop', label: 'Laptop', width: 1280, height: 800, dpr: 2, mobile: false, group: 'desktop' },
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900, dpr: 1, mobile: false, group: 'desktop' },
  { id: 'desktop-hd', label: 'Desktop HD', width: 1920, height: 1080, dpr: 1, mobile: false, group: 'desktop' }
]

export type PreviewColorScheme = 'light' | 'dark'

/**
 * A preview tab's viewport. `fill` is the pane's own size — what the page saw
 * before presets existed, and still the default. `custom` takes `width` /
 * `height` as given.
 */
export interface PreviewViewport {
  device: 'fill' | 'custom' | string
  width?: number
  height?: number
  rotated?: boolean
  /** Absent follows the system, which is what an unemulated page sees. */
  colorScheme?: PreviewColorScheme
}

export const FILL_VIEWPORT: PreviewViewport = { device: 'fill' }

/** The smallest and largest custom side the preview will lay out. */
export const VIEWPORT_MIN = 200
export const VIEWPORT_MAX = 4096

export function previewDevice(id: string | undefined): PreviewDevice | undefined {
  if (!id) return undefined
  const key = id.trim().toLowerCase().replace(/[\s_]+/g, '-')
  return PREVIEW_DEVICES.find((d) => d.id === key || d.label.toLowerCase().replace(/[\s_]+/g, '-') === key)
}

/**
 * The size a viewport lays out at, or null for `fill` (the pane decides).
 * Custom sides are clamped so a typo cannot ask for a 100,000 px guest.
 */
export function viewportSize(
  v: PreviewViewport
): { width: number; height: number; dpr: number; mobile: boolean; os?: 'ios' | 'android' } | null {
  const clamp = (n: number): number => Math.round(Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, n)))
  let size: { width: number; height: number; dpr: number; mobile: boolean; os?: 'ios' | 'android' } | null = null
  if (v.device === 'custom') {
    if (!v.width || !v.height) return null
    size = { width: clamp(v.width), height: clamp(v.height), dpr: 0, mobile: false }
  } else if (v.device !== 'fill') {
    const d = previewDevice(v.device)
    if (!d) return null
    size = { width: d.width, height: d.height, dpr: d.dpr, mobile: d.mobile, os: d.os }
  }
  if (size && v.rotated) size = { ...size, width: size.height, height: size.width }
  return size
}

/** A one-line description for a tool result or a tooltip. */
export function describeViewport(v: PreviewViewport): string {
  const scheme = v.colorScheme ? `, ${v.colorScheme} scheme` : ''
  if (v.device === 'fill') return `fills the pane${scheme}`
  const size = viewportSize(v)
  const name = v.device === 'custom' ? 'Custom' : (previewDevice(v.device)?.label ?? v.device)
  if (!size) return `${name}${scheme}`
  return `${name} ${size.width}×${size.height}${v.rotated ? ' (landscape)' : ''}${scheme}`
}

/**
 * A change to a viewport, as the agent's `preview_resize` asks for one: only
 * what it names moves. `colorScheme: null` stops emulating the scheme.
 */
export type PreviewViewportPatch = Partial<Omit<PreviewViewport, 'colorScheme'>> & {
  colorScheme?: PreviewColorScheme | null
}

export function applyViewportPatch(v: PreviewViewport, p: PreviewViewportPatch): PreviewViewport {
  const next: PreviewViewport = { ...v }
  if (p.device !== undefined) {
    next.device = p.device
    if (p.device !== 'custom') {
      delete next.width
      delete next.height
    }
    // A new device starts upright unless the same change says otherwise.
    if (p.device !== v.device && p.rotated === undefined) delete next.rotated
  }
  if (p.width !== undefined) next.width = p.width
  if (p.height !== undefined) next.height = p.height
  if (p.rotated !== undefined) {
    if (p.rotated) next.rotated = true
    else delete next.rotated
  }
  if (p.colorScheme === null) delete next.colorScheme
  else if (p.colorScheme) next.colorScheme = p.colorScheme
  return next
}
