import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto'
import { encryptPayload, generateVapidKeys, sendPush, vapidAuthorization } from '../src/main/webPush.ts'

// RFC 8291 §5 and Appendix A, with the whitespace taken out.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ'
}

const b64 = (s: string): Buffer => Buffer.from(s, 'base64url')

test('encryption reproduces RFC 8291 byte for byte', () => {
  const out = encryptPayload(
    Buffer.from(RFC.plaintext),
    { p256dh: RFC.uaPublic, auth: RFC.auth },
    { senderPrivateKey: b64(RFC.asPrivate), salt: b64(RFC.salt) }
  )
  // As bytes: the 86-byte header is not a multiple of three, so the two
  // base64 strings cannot simply be joined.
  assert.deepEqual(out, Buffer.concat([b64(RFC.header), b64(RFC.ciphertext)]))
  // And the whole message as RFC 8291 §5 prints it.
  assert.equal(
    out.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
  )
})

/** The user agent's side of RFC 8291, independent of the sender's code. */
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16)
  const idlen = body.readUInt8(20)
  const asPublic = body.subarray(21, 21 + idlen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const shared = ecdh.computeSecret(asPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const record = body.subarray(21 + idlen)
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(record.subarray(record.length - 16))
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()])
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter')
  return plain.subarray(0, -1).toString('utf8')
}

test('a fresh message decrypts on the receiving side', () => {
  const body = encryptPayload(Buffer.from('{"title":"Done"}'), { p256dh: RFC.uaPublic, auth: RFC.auth })
  assert.equal(decrypt(body, b64(RFC.uaPrivate), b64(RFC.uaPublic), b64(RFC.auth)), '{"title":"Done"}')
})

test('payloads past one record are refused, not split', () => {
  assert.throws(() => encryptPayload(Buffer.alloc(5000), { p256dh: RFC.uaPublic, auth: RFC.auth }))
})

test('VAPID: origin audience, a day at most, a subject, and a JOSE signature', () => {
  const keys = generateVapidKeys()
  assert.equal(b64(keys.publicKey).length, 65)
  assert.equal(b64(keys.privateKey).length, 32)
  const now = Date.UTC(2026, 9, 14)
  const header = vapidAuthorization('https://web.push.apple.com/QAbc/def?x=1', keys, 'https://example.com', now)
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
  assert.ok(m, header)
  const [, h, c, sig, k] = m
  assert.equal(k, keys.publicKey)
  assert.deepEqual(JSON.parse(b64(h).toString()), { typ: 'JWT', alg: 'ES256' })
  const claims = JSON.parse(b64(c).toString())
  assert.equal(claims.aud, 'https://web.push.apple.com')
  assert.equal(claims.sub, 'https://example.com')
  assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600)
  // 64 raw bytes (r||s), and it verifies against the advertised public key.
  assert.equal(b64(sig).length, 64)
  const pub = b64(keys.publicKey)
  const key = createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }
  })
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, b64(sig)))
})

test('sendPush posts an encrypted, signed message and reads 410 as gone', async () => {
  const keys = generateVapidKeys()
  const seen: { url: string; headers: Record<string, string>; body: Buffer }[] = []
  const fake = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) })
    return new Response(null, { status: seen.length === 1 ? 201 : 410 })
  }) as unknown as typeof fetch
  const target = { endpoint: 'https://push.example/sub/1', p256dh: RFC.uaPublic, auth: RFC.auth }
  const first = await sendPush(target, { title: 'Done' }, keys, { subject: 'https://example.com', fetch: fake })
  assert.deepEqual(first, { status: 201, gone: false })
  const { headers, body } = seen[0]
  assert.equal(headers['content-encoding'], 'aes128gcm')
  assert.match(headers.authorization, /^vapid t=.+, k=/)
  assert.ok(Number(headers.ttl) > 0)
  assert.deepEqual(JSON.parse(decrypt(body, b64(RFC.uaPrivate), b64(RFC.uaPublic), b64(RFC.auth))), { title: 'Done' })
  const second = await sendPush(target, { title: 'Done' }, keys, { subject: 'https://example.com', fetch: fake })
  assert.deepEqual(second, { status: 410, gone: true })
})
