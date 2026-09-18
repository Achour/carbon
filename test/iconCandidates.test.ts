import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dirIconRefs,
  htmlIconRefs,
  manifestIconRefs,
  refPaths
} from '../src/main/iconCandidates.ts'

// The manifest that started this: a project whose icon Carbon could not find
// while every other tool could. Verbatim from theverifiedportal.
const PORTAL_MANIFEST = JSON.stringify({
  name: 'The Verified Portal',
  icons: [
    { src: '/favicon-v5.ico', sizes: '16x16 24x24 32x32 48x48 64x64', type: 'image/x-icon' },
    {
      src: '/images/brand/verified-portal-icon-v3-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any'
    },
    {
      src: '/images/brand/verified-portal-icon-v3-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any'
    }
  ]
})

test('a manifest prefers a large PNG over the stacked .ico it lists first', () => {
  assert.deepEqual(manifestIconRefs(PORTAL_MANIFEST), [
    '/images/brand/verified-portal-icon-v3-192.png',
    '/images/brand/verified-portal-icon-v3-512.png',
    '/favicon-v5.ico'
  ])
})

test('a scalable manifest icon outranks every raster', () => {
  const text = JSON.stringify({
    icons: [
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }
    ]
  })
  assert.equal(manifestIconRefs(text)[0], 'icon.svg')
})

test('a maskable icon ranks below every unmasked one, and is still offered', () => {
  const text = JSON.stringify({
    icons: [
      { src: 'masked.png', sizes: '512x512', purpose: 'maskable' },
      { src: 'plain.png', sizes: '16x16' }
    ]
  })
  assert.deepEqual(manifestIconRefs(text), ['plain.png', 'masked.png'])
})

test('a maskable icon that also offers itself unmasked is not demoted', () => {
  const text = JSON.stringify({
    icons: [
      { src: 'small.png', sizes: '32x32' },
      { src: 'both.png', sizes: '192x192', purpose: 'any maskable' }
    ]
  })
  assert.equal(manifestIconRefs(text)[0], 'both.png')
})

test('a broken manifest contributes nothing rather than throwing', () => {
  assert.deepEqual(manifestIconRefs('{"icons": ['), [])
  assert.deepEqual(manifestIconRefs('not json at all'), [])
  assert.deepEqual(manifestIconRefs(JSON.stringify({ icons: 'favicon.png' })), [])
  assert.deepEqual(manifestIconRefs(JSON.stringify({ icons: [null, 7, { sizes: '32x32' }] })), [])
})

test('declared HTML icons rank by size, not by document order', () => {
  const html = `<html><head>
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
    <link rel="shortcut icon" href="/favicon.ico">
  </head><body><link rel="icon" href="/body-ignored.png"></body></html>`
  assert.deepEqual(htmlIconRefs(html), [
    '/apple-touch-icon.png',
    '/favicon-16.png',
    '/favicon.ico'
  ])
})

test('an href keeps its query string, and is ranked on the name under it', () => {
  const html = `<head><link rel="icon" href="/favicon.svg?v=4"></head>`
  assert.deepEqual(htmlIconRefs(html), ['/favicon.svg?v=4'])
})

test('a directory listing yields only icon-shaped names', () => {
  const picked = dirIconRefs([
    'og-image.png',
    'robots.txt',
    'icons.json',
    'logo.tsx',
    'favicon-32x32.png',
    'screenshot-1280x720.png'
  ])
  assert.deepEqual(picked, ['favicon-32x32.png'])
})

test("a directory's versioned favicons resolve to the largest, newest one", () => {
  // The listing that made this tier necessary, alphabetized the way readdir
  // hands it over.
  const picked = dirIconRefs([
    'apple-touch-icon-v2.png',
    'apple-touch-icon-v3.png',
    'favicon-16x16.png',
    'favicon-32x32.png',
    'favicon-48x48.png',
    'favicon-v2.ico',
    'favicon-v5-16x16.png',
    'favicon-v5-64x64.png',
    'favicon-v5.ico'
  ])
  // 64px is the biggest declared raster, and the apple-touch pair declares no
  // size at all — usable, and outranked by anything that says.
  assert.equal(picked[0], 'favicon-v5-64x64.png')
  assert.ok(picked.indexOf('apple-touch-icon-v3.png') < picked.indexOf('favicon-16x16.png'))
  // Every candidate is still offered, so a sniff that refuses one falls through.
  assert.equal(picked.length, 9)
})

test('an SVG in a directory wins whatever it is called', () => {
  assert.equal(dirIconRefs(['favicon-512x512.png', 'logo.svg'])[0], 'logo.svg')
})

test('a root-relative ref tries the served directory before the repo root', () => {
  assert.deepEqual(refPaths('/repo', 'public', '/favicon.ico'), [
    '/repo/public/favicon.ico',
    '/repo/favicon.ico'
  ])
})

test('a ref relative to the declaring file resolves beside it', () => {
  assert.deepEqual(refPaths('/repo', 'public', 'icons/mark.png'), ['/repo/public/icons/mark.png'])
})

test('a ref declared at the repo root yields one path, not a duplicate', () => {
  assert.deepEqual(refPaths('/repo', '', '/favicon.ico'), ['/repo/favicon.ico'])
})

test("create-react-app's placeholder is the site root and comes off", () => {
  assert.deepEqual(refPaths('/repo', 'public', '%PUBLIC_URL%/favicon.ico'), [
    '/repo/public/favicon.ico',
    '/repo/favicon.ico'
  ])
})

test('a ref that is not a file in this repo is refused', () => {
  assert.deepEqual(refPaths('/repo', 'public', 'https://cdn.example.com/icon.png'), [])
  assert.deepEqual(refPaths('/repo', 'public', 'data:image/png;base64,AAAA'), [])
  assert.deepEqual(refPaths('/repo', 'public', '//cdn.example.com/icon.png'), [])
  assert.deepEqual(refPaths('/repo', 'public', '../../../etc/passwd'), [])
  assert.deepEqual(refPaths('/repo', 'public', ''), [])
})
