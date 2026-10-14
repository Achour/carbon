import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  certDomainFromStatus,
  hashToken,
  isPrivateLan,
  isTailscale,
  lastReplyText,
  parseCookies,
  remoteAddressAllowed,
  remoteAddresses,
  safeEqual,
  splitCertOutput,
  splitDeviceCredential
} from '../src/main/remoteNet.ts'

test('Tailscale ranges, both families, including v4-mapped peers', () => {
  assert.equal(isTailscale('100.64.0.1'), true)
  assert.equal(isTailscale('100.127.255.254'), true)
  assert.equal(isTailscale('::ffff:100.101.2.3'), true)
  assert.equal(isTailscale('fd7a:115c:a1e0::1'), true)
  // Either side of the /10 is ordinary public space.
  assert.equal(isTailscale('100.63.255.255'), false)
  assert.equal(isTailscale('100.128.0.1'), false)
  assert.equal(isTailscale('fd7a:115c:a1e1::1'), false)
})

test('private LAN ranges', () => {
  for (const a of ['10.0.0.5', '172.16.0.1', '172.31.9.9', '192.168.1.20', '169.254.1.1', 'fe80::1', 'fd12::3'])
    assert.equal(isPrivateLan(a), true, a)
  for (const a of ['172.32.0.1', '8.8.8.8', '2001:db8::1', '100.100.1.1'])
    assert.equal(isPrivateLan(a), false, a)
})

test('who may connect', () => {
  assert.equal(remoteAddressAllowed('127.0.0.1', false), true)
  assert.equal(remoteAddressAllowed('::1', false), true)
  assert.equal(remoteAddressAllowed('100.88.1.2', false), true)
  // The LAN only on opt-in, the internet never.
  assert.equal(remoteAddressAllowed('192.168.1.20', false), false)
  assert.equal(remoteAddressAllowed('192.168.1.20', true), true)
  assert.equal(remoteAddressAllowed('8.8.8.8', true), false)
  assert.equal(remoteAddressAllowed(undefined, true), false)
})

test('offered addresses put Tailscale first and skip loopback and IPv6', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false }
    ],
    utun4: [{ address: '100.90.1.2', family: 'IPv4', internal: false }],
    en1: [{ address: '8.8.4.4', family: 'IPv4', internal: false }]
  } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>
  assert.deepEqual(remoteAddresses(ifaces, true), [
    { address: '100.90.1.2', kind: 'tailscale' },
    { address: '192.168.1.20', kind: 'lan' }
  ])
  assert.deepEqual(remoteAddresses(ifaces, false), [{ address: '100.90.1.2', kind: 'tailscale' }])
})

test('cookies and device credentials', () => {
  assert.deepEqual(parseCookies('a=1; carbon_device=abc.def%3D; junk'), { a: '1', carbon_device: 'abc.def=' })
  assert.deepEqual(splitDeviceCredential('dev1.tok.en'), { id: 'dev1', token: 'tok.en' })
  assert.equal(splitDeviceCredential('.tok'), null)
  assert.equal(splitDeviceCredential('dev.'), null)
  assert.equal(splitDeviceCredential(undefined), null)
})

test('token hashing and comparison', () => {
  assert.equal(hashToken('x'), hashToken('x'))
  assert.notEqual(hashToken('x'), hashToken('y'))
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
})

test('a Tailscale certificate needs a running node and a cert domain', () => {
  const ok = certDomainFromStatus(
    JSON.stringify({ BackendState: 'Running', CertDomains: ['mac.tail1234.ts.net'] })
  )
  assert.deepEqual(ok, { domain: 'mac.tail1234.ts.net' })
  // HTTPS certificates off for the tailnet: the one step only the user can take.
  const off = certDomainFromStatus(JSON.stringify({ BackendState: 'Running', CertDomains: null }))
  assert.ok('reason' in off && /HTTPS Certificates/.test(off.reason))
  const stopped = certDomainFromStatus(JSON.stringify({ BackendState: 'Stopped' }))
  assert.ok('reason' in stopped && /not connected/.test(stopped.reason))
  const login = certDomainFromStatus(JSON.stringify({ BackendState: 'NeedsLogin' }))
  assert.ok('reason' in login && /signed out/.test(login.reason))
  assert.ok('reason' in certDomainFromStatus('not json'))
})

test('cert output splits into chain and key by block type', () => {
  const c = (n: string): string => `-----BEGIN CERTIFICATE-----\n${n}\n-----END CERTIFICATE-----`
  const k = '-----BEGIN EC PRIVATE KEY-----\nKEY\n-----END EC PRIVATE KEY-----'
  assert.deepEqual(splitCertOutput(`${c('LEAF')}\n${c('INTER')}\n${k}\n`), {
    cert: `${c('LEAF')}\n${c('INTER')}\n`,
    key: `${k}\n`
  })
  assert.equal(splitCertOutput(c('LEAF')), null)
  assert.equal(splitCertOutput(''), null)
})

test("a notification's body is the opening of the last reply, as plain text", () => {
  const ts = 0
  const reply = (text: string) => ({ id: 'a', role: 'assistant' as const, ts, parts: [{ type: 'text' as const, text }] })
  assert.equal(
    lastReplyText([
      { id: 'u', role: 'user', ts, text: 'go' } as never,
      reply('## Done\n\n**All 52 tests pass** — see [the diff](x.ts).\n\n```ts\nconst a = 1\n```\n- `npm test` green')
    ]),
    'Done All 52 tests pass — see the diff. npm test green'
  )
  // The turn's own event after the reply does not hide it.
  assert.equal(lastReplyText([reply('Fixed it.'), { id: 'e', role: 'event', kind: 'turn', text: '', ts }]), 'Fixed it.')
  // A turn with no words of its own says nothing, rather than an older turn's reply.
  assert.equal(lastReplyText([reply('Old.'), { id: 'u', role: 'user', ts, text: 'again' } as never]), null)
})
