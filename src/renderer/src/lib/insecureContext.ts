/**
 * Two browser APIs that exist only in a secure context (HTTPS or localhost),
 * with fallbacks for the one page that is neither: the phone client, which
 * reaches the Mac at `http://<name>.local:7391`. Safari leaves both undefined
 * there, so a call throws — which is how every photo picked on the phone
 * failed (`crypto.randomUUID is not a function`), and how every copy button
 * the phone borrows from the desktop transcript would have.
 */

/** `crypto.randomUUID()`, or the same v4 shape from `getRandomValues`, which is not gated. */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * Put text on the clipboard. Without `navigator.clipboard` it falls back to a
 * selected textarea and `execCommand('copy')`, deprecated but still honoured
 * inside the tap that calls this.
 */
export function copyText(text: string): void {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {})
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  area.setSelectionRange(0, text.length)
  try {
    document.execCommand('copy')
  } finally {
    area.remove()
  }
}
