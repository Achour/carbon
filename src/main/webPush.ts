import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto'

/**
 * Web Push from the Mac to a paired phone: RFC 8291 message encryption over
 * RFC 8188's `aes128gcm` coding, and RFC 8292 VAPID to identify the sender.
 *
 * Written against `node:crypto` rather than pulled in as a dependency, because
 * it is a page of code and every step is pinned against the RFC's own
 * intermediate values (`test/webPush.test.ts`). Kept to `node:*` imports so
 * `node --test` runs it directly.
 *
 * No Apple Developer account is involved: a Home Screen web app's subscription
 * points at Apple's web push service, which accepts any sender that signs with
 * the key the subscription was made for. See `docs/remote.md`.
 */

/** What a browser's `PushSubscription.toJSON()` carries, flattened. */
export interface PushTarget {
  endpoint: string
  /** The subscription's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string
  /** Its 16-byte authentication secret, base64url. */
  auth: string
}

/** The application server's VAPID key pair, both raw and base64url. */
export interface VapidKeys {
  /** Uncompressed P-256 point, 65 bytes — what `applicationServerKey` takes. */
  publicKey: string
  /** The 32-byte private scalar. */
  privateKey: string
}

/** RFC 8188's record size. One record: the payload has to fit inside it. */
const RECORD_SIZE = 4096
/** Delimiter octet plus the GCM tag, both inside the one record. */
const RECORD_OVERHEAD = 17
/** The largest plaintext one record holds. */
export const MAX_PAYLOAD = RECORD_SIZE - RECORD_OVERHEAD

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: pad32(ecdh.getPrivateKey()).toString('base64url')
  }
}

/** A scalar with leading zero bytes can come back short; the JWK wants 32. */
function pad32(b: Buffer): Buffer {
  return b.length >= 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b])
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length))
}

/**
 * Encrypt one push message for one subscription. `senderPrivateKey` and
 * `salt` exist for the RFC's test vector; in use both are fresh per message.
 */
export function encryptPayload(
  payload: Buffer,
  target: Pick<PushTarget, 'p256dh' | 'auth'>,
  opts: { senderPrivateKey?: Buffer; salt?: Buffer } = {}
): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error(`Push payload is ${payload.length} bytes; the limit is ${MAX_PAYLOAD}`)
  const uaPublic = Buffer.from(target.p256dh, 'base64url')
  const authSecret = Buffer.from(target.auth, 'base64url')
  const salt = opts.salt ?? randomBytes(16)
  const ecdh = createECDH('prime256v1')
  if (opts.senderPrivateKey) ecdh.setPrivateKey(opts.senderPrivateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)

  // RFC 8291 §3.3: the auth secret is the *salt* of the first HKDF and the
  // ECDH secret its input — the order Node's `hkdfSync` makes easy to swap.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hkdf(shared, authSecret, keyInfo, 32)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // One record, so it is the last: delimiter 0x02, no further padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, body])
}

function signingKey(keys: VapidKeys): KeyObject {
  const pub = Buffer.from(keys.publicKey, 'base64url')
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
      d: keys.privateKey
    }
  })
}

/**
 * The `Authorization` header RFC 8292 defines. Apple's service is the strict
 * one: `aud` must be the endpoint's bare origin, `exp` within a day, `sub`
 * present, and the signature raw `r||s` (JOSE), not DER — it answers each of
 * those mistakes with a 403 `BadJwtToken`.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc(claims)}`
  const signature = sign('sha256', Buffer.from(unsigned), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`
}

export interface PushResult {
  status: number
  /** The push service says the subscription no longer exists: drop it. */
  gone: boolean
}

/** Deliver one message. Throws only when the push service could not be reached. */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  keys: VapidKeys,
  opts: { subject: string; ttlSeconds?: number; fetch?: typeof fetch }
): Promise<PushResult> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), target)
  const res = await (opts.fetch ?? fetch)(target.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(target.endpoint, keys, opts.subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      // A finished turn is worth knowing about for a day; past that it is noise.
      ttl: String(opts.ttlSeconds ?? 24 * 3600),
      urgency: 'high'
    },
    body: new Uint8Array(body)
  })
  await res.arrayBuffer().catch(() => undefined)
  return { status: res.status, gone: res.status === 404 || res.status === 410 }
}
