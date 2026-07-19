import type { DockIconPalette } from '@shared/types'

const HEX_COLOR = /^#[0-9a-f]{6}$/i

function safeColor(value: string, fallback: string): string {
  return HEX_COLOR.test(value) ? value : fallback
}

/**
 * The runtime Dock icon keeps the packaged Carbon geometry, but takes its
 * surfaces and monogram directly from the active renderer theme.
 */
export function dockIconSvg(input: DockIconPalette): string {
  const background = safeColor(input.background, '#1c1c1c')
  const surface = safeColor(input.surface, '#2b2b2b')
  const code = safeColor(input.code, '#131313')
  const foreground = safeColor(input.foreground, '#f0f0f0')
  const primary = safeColor(input.primary, '#e4e4e4')

  return `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${surface}"/>
      <stop offset="0.56" stop-color="${background}"/>
      <stop offset="1" stop-color="${code}"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${primary}"/>
      <stop offset="0.58" stop-color="${primary}"/>
      <stop offset="1" stop-color="${foreground}" stop-opacity="0.72"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${foreground}" stop-opacity="0.16"/>
      <stop offset="0.42" stop-color="${foreground}" stop-opacity="0"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="22" flood-color="#000000" flood-opacity="0.42"/>
    </filter>
  </defs>
  <g filter="url(#shadow)">
    <rect x="112" y="104" width="800" height="800" rx="184" fill="url(#bg)"/>
    <rect x="112" y="104" width="800" height="800" rx="184" fill="url(#sheen)"/>
    <rect x="113.5" y="105.5" width="797" height="797" rx="182.5" fill="none"
      stroke="${foreground}" stroke-opacity="0.14" stroke-width="3"/>
  </g>
  <path d="M512 302 L654 384 L654 550 L512 632 L370 550 L370 384 Z"
    fill="none" stroke="${primary}" stroke-opacity="0.18" stroke-width="18"
    stroke-linejoin="round"/>
  <path d="M652 385 A205 205 0 1 0 652 641"
    fill="none" stroke="url(#mark)" stroke-width="92" stroke-linecap="round"/>
</svg>`
}
