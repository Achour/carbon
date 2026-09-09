import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheFileName,
  imageMime,
  originOf,
  parseIconLinks,
  rankIconLinks,
  resolveIconUrls,
  sniffImage
} from '../src/main/faviconCache.ts'

// Nothing here touches the network: these are the parse and the validation gate,
// which is where every real failure of a favicon resolver lives.

// ---- originOf ----

test('an origin is scheme + host + non-default port', () => {
  assert.equal(originOf('https://php.net/manual/en/index.php'), 'https://php.net')
  assert.equal(originOf('http://example.com:8080/a?b#c'), 'http://example.com:8080')
  assert.equal(originOf('https://example.com:443/a'), 'https://example.com')
})

test('an origin is case- and whitespace-insensitive, so one host is one entry', () => {
  assert.equal(originOf('  HTTPS://Example.COM/A  '), 'https://example.com')
  assert.equal(originOf('https://example.com/b'), originOf('https://example.com/c'))
})

test('anything that is not http(s), or does not parse, has no origin', () => {
  for (const url of [
    'mailto:a@b.com',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'javascript:alert(1)',
    'data:text/html,<b>hi',
    'not a url',
    '',
    '/relative/path'
  ]) {
    assert.equal(originOf(url), null, url)
  }
})

// ---- sniffImage / imageMime: the validation gate ----

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(0)])
const ico = new Uint8Array([0x00, 0x00, 0x01, 0x00, ...new Array(28).fill(1)])
const bytes = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)))

test('magic bytes name the format', () => {
  assert.equal(sniffImage(png), 'image/png')
  assert.equal(sniffImage(ico), 'image/x-icon')
  assert.equal(sniffImage(bytes('GIF89a' + 'x'.repeat(20))), 'image/gif')
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)])), 'image/jpeg')
  assert.equal(sniffImage(bytes('RIFF????WEBPVP8 ' + 'x'.repeat(16))), 'image/webp')
  assert.equal(sniffImage(bytes('nothing in particular here')), null)
})

test('an HTML body is refused even when the server calls it an icon', () => {
  // The failure this whole gate exists for: an SPA's catch-all route answering
  // 200 at /favicon.ico, typed off the extension rather than the bytes.
  const page = bytes('<!DOCTYPE html>\n<html><head><title>Not found</title></head></html>')
  assert.equal(imageMime(page, 'image/x-icon'), null)
  assert.equal(imageMime(page, 'text/html; charset=utf-8'), null)
  assert.equal(imageMime(bytes('<html lang="en"><body>404 — no such file</body></html>'), 'image/png'), null)
})

test('an empty or tiny 200 is not an icon', () => {
  assert.equal(imageMime(new Uint8Array(0), 'image/x-icon'), null)
  assert.equal(imageMime(bytes('tiny'), 'image/png'), null)
})

test('the sniffed type outranks a wrong content-type', () => {
  assert.equal(imageMime(png, 'text/plain'), 'image/png')
  assert.equal(imageMime(png, null), 'image/png')
  assert.equal(imageMime(ico, 'application/octet-stream'), 'image/x-icon')
})

test('an SVG is the one markup body allowed through', () => {
  const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16"/></svg>')
  assert.equal(imageMime(svg, 'image/svg+xml'), 'image/svg+xml')
  // Declared as something else, or not declared at all: the `<svg` still decides.
  assert.equal(imageMime(svg, 'text/plain'), 'image/svg+xml')
  const declared = bytes('<?xml version="1.0"?>\n<!-- made by hand -->\n<svg width="16"></svg>')
  assert.equal(imageMime(declared, null), 'image/svg+xml')
})

test('an unsniffable body falls back to a well-formed image content-type only', () => {
  const odd = bytes('ROIF not a format we know, but 32+ bytes long')
  assert.equal(imageMime(odd, 'image/vnd.microsoft.icon'), 'image/vnd.microsoft.icon')
  assert.equal(imageMime(odd, 'image/png; charset=binary'), 'image/png')
  assert.equal(imageMime(odd, 'application/json'), null)
  assert.equal(imageMime(odd, 'image/<script>'), null)
  assert.equal(imageMime(odd, ''), null)
})

// ---- parseIconLinks ----

const PAGE = `<!doctype html><html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/style.css">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="mask-icon" href="/safari-pinned-tab.svg" color="#000">
  <link rel="manifest" href="/site.webmanifest">
</head><body>
  <link rel="icon" href="/decoy-in-body.png">
</body></html>`

test('only icon links in the head are collected', () => {
  const links = parseIconLinks(PAGE)
  assert.deepEqual(
    links.map((l) => l.href),
    ['/apple-touch-icon.png', '/favicon-16.png', '/favicon-32.png']
  )
})

test('rel spellings, quoting and entities are all handled', () => {
  const links = parseIconLinks(
    `<head>
       <link rel='shortcut icon' href='/legacy.ico'>
       <link REL=ICON HREF=/unquoted.png>
       <link rel="apple-touch-icon-precomposed" href="/pre.png">
       <link rel="icon" href="/icon.png?v=1&amp;size=32">
       <link rel="icon">
       <link rel="icon" href="">
     </head>`
  )
  assert.deepEqual(
    links.map((l) => l.href),
    ['/legacy.ico', '/unquoted.png', '/pre.png', '/icon.png?v=1&size=32']
  )
})

test('a page with no head terminator still parses', () => {
  const links = parseIconLinks('<html><head><link rel="icon" href="/a.png">')
  assert.deepEqual(links.map((l) => l.href), ['/a.png'])
  assert.deepEqual(parseIconLinks(''), [])
  assert.deepEqual(parseIconLinks('<html><body>plain</body></html>'), [])
})

// ---- rankIconLinks ----

test('a declared icon outranks an apple-touch icon, and 32px outranks the rest', () => {
  assert.deepEqual(
    rankIconLinks(parseIconLinks(PAGE)).map((l) => l.href),
    ['/favicon-32.png', '/favicon-16.png', '/apple-touch-icon.png']
  )
})

test('a scalable icon is ideal and an undeclared size is a mild penalty', () => {
  const ranked = rankIconLinks(
    parseIconLinks(`<head>
      <link rel="icon" sizes="512x512" href="/big.png">
      <link rel="icon" href="/plain.ico">
      <link rel="icon" sizes="any" href="/scalable.svg">
    </head>`)
  )
  assert.deepEqual(ranked.map((l) => l.href), ['/scalable.svg', '/plain.ico', '/big.png'])
})

test('ranking is total: equal scores keep document order', () => {
  const links = parseIconLinks(
    '<head><link rel="icon" href="/a.png"><link rel="icon" href="/b.png"></head>'
  )
  assert.deepEqual(rankIconLinks(links).map((l) => l.href), ['/a.png', '/b.png'])
  assert.deepEqual(rankIconLinks(links).map((l) => l.href), ['/a.png', '/b.png'])
})

// ---- resolveIconUrls ----

test('relative hrefs resolve against the page that was actually served', () => {
  // php.net redirects to www.php.net; resolving against the requested origin
  // would point a relative href at a host that never served the page.
  const links = parseIconLinks(
    '<head><link rel="icon" href="images/favicon.png"><link rel="icon" href="/root.png"></head>'
  )
  assert.deepEqual(resolveIconUrls('https://www.php.net/', links), [
    'https://www.php.net/images/favicon.png',
    'https://www.php.net/root.png'
  ])
})

test('protocol-relative and cross-origin hrefs are kept; other schemes are not', () => {
  const links = parseIconLinks(
    `<head>
       <link rel="icon" href="//cdn.example.com/f.png">
       <link rel="icon" href="https://assets.example.org/f.svg">
       <link rel="icon" href="javascript:alert(1)">
       <link rel="icon" href="data:image/png;base64,AAAA">
     </head>`
  )
  assert.deepEqual(resolveIconUrls('https://example.com/', links), [
    'https://cdn.example.com/f.png',
    'https://assets.example.org/f.svg'
  ])
})

test('duplicate hrefs collapse to one request', () => {
  const links = parseIconLinks(
    '<head><link rel="icon" href="/f.png"><link rel="icon" href="https://a.com/f.png"></head>'
  )
  assert.deepEqual(resolveIconUrls('https://a.com/', links), ['https://a.com/f.png'])
})

// ---- cacheFileName ----

test('a cache file is readable, safe and unique per origin', () => {
  assert.match(cacheFileName('https://github.com'), /^github\.com-[0-9a-f]{8}\.json$/)
  assert.match(cacheFileName('http://github.com'), /^http_github\.com-[0-9a-f]{8}\.json$/)
  // Same host, different scheme or port: different file.
  assert.notEqual(cacheFileName('https://github.com'), cacheFileName('http://github.com'))
  assert.notEqual(cacheFileName('https://a.com'), cacheFileName('https://a.com:8443'))
  assert.equal(cacheFileName('https://a.com'), cacheFileName('https://a.com'))
})

test('a cache file name never escapes its directory', () => {
  for (const origin of ['https://a.com:8443', 'http://xn--80ak6aa92e.com', 'https://[::1]:3000']) {
    const name = cacheFileName(origin)
    assert.doesNotMatch(name, /[/\\]/, origin)
    assert.doesNotMatch(name, /^\.\.?/, origin)
    assert.ok(name.length < 80, origin)
  }
})
