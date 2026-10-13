import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { NetworkInterfaceInfo } from 'node:os'

/**
 * The pure half of remote access (`remoteAccess.ts`): who may connect, which
 * addresses to show, and the credential arithmetic. Kept to `node:*` imports so
 * `node --test` runs it directly — this is the part whose mistakes are security
 * mistakes, so it is the part worth pinning.
 */

/** `::ffff:100.101.1.2` is how an IPv4 peer looks on a dual-stack socket. */
function unmapped(address: string): string {
  return address.startsWith('::ffff:') && address.includes('.') ? address.slice(7) : address
}

function ipv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null
}

/** First 16-bit group of an IPv6 address, or null for anything else. */
function ipv6Head(address: string): number | null {
  if (!address.includes(':')) return null
  const head = address.split(':')[0]
  if (head === '') return 0
  return /^[0-9a-f]{1,4}$/i.test(head) ? parseInt(head, 16) : null
}

export function isLoopback(address: string): boolean {
  const a = unmapped(address)
  if (a === '::1') return true
  const v4 = ipv4(a)
  return !!v4 && v4[0] === 127
}

/**
 * Tailscale's address space: the CGNAT block `100.64.0.0/10` for IPv4 and
 * `fd7a:115c:a1e0::/48` for IPv6. Traffic to these rides WireGuard, which is
 * why plain HTTP is acceptable on them and nowhere else.
 */
export function isTailscale(address: string): boolean {
  const a = unmapped(address)
  const v4 = ipv4(a)
  if (v4) return v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127
  return a.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

/** RFC 1918, link-local, and IPv6 unique-local / link-local. */
export function isPrivateLan(address: string): boolean {
  const a = unmapped(address)
  const v4 = ipv4(a)
  if (v4) {
    return (
      v4[0] === 10 ||
      (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) ||
      (v4[0] === 192 && v4[1] === 168) ||
      (v4[0] === 169 && v4[1] === 254)
    )
  }
  const head = ipv6Head(a)
  if (head === null) return false
  return (head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80
}

/**
 * Whether a peer may talk to the server at all, before any credential is read.
 * Tailscale and loopback always; the local network only when the user opted in,
 * since there the pairing code and the cookie cross the air unencrypted. The
 * public internet never — the server binds every interface so Tailscale coming
 * up after Carbon needs no restart, and this is what keeps that from meaning
 * "reachable from anywhere a port forward points".
 */
export function remoteAddressAllowed(address: string | undefined, allowLan: boolean): boolean {
  if (!address) return false
  if (isLoopback(address) || isTailscale(address)) return true
  return allowLan && isPrivateLan(address)
}

export interface RemoteAddress {
  address: string
  kind: 'tailscale' | 'lan'
}

/**
 * The addresses worth offering the phone, Tailscale first. IPv4 only: an IPv6
 * literal in a URL needs brackets and is miserable to type on a phone, and
 * every interface that has one here also has a v4.
 */
export function remoteAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  allowLan: boolean
): RemoteAddress[] {
  const out: RemoteAddress[] = []
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal || info.family !== 'IPv4') continue
      if (isTailscale(info.address)) out.push({ address: info.address, kind: 'tailscale' })
      else if (allowLan && isPrivateLan(info.address)) out.push({ address: info.address, kind: 'lan' })
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'tailscale' ? -1 : 1))
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = pair.slice(0, eq).trim()
    if (!key) continue
    try {
      out[key] = decodeURIComponent(pair.slice(eq + 1).trim())
    } catch {
      out[key] = pair.slice(eq + 1).trim()
    }
  }
  return out
}

/** Only a hash of a device's token is persisted; the token lives on the phone. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Six digits: short enough to type, and pairing spends at most a few guesses. */
export function newPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * `<deviceId>.<token>` — the cookie a paired phone carries. The id picks the
 * record so the check is one hash compare, not one per paired device.
 */
export function splitDeviceCredential(value: string | undefined): { id: string; token: string } | null {
  if (!value) return null
  const dot = value.indexOf('.')
  if (dot <= 0 || dot === value.length - 1) return null
  return { id: value.slice(0, dot), token: value.slice(dot + 1) }
}
