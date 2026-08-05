import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareVersions,
  isNewerVersion,
  pickAsset,
  updateFromRelease
} from '../src/main/updateCheck.ts'

test('compareVersions orders the release channel', () => {
  assert.ok(compareVersions('0.2.0', '0.1.0') > 0)
  assert.ok(compareVersions('0.1.0', '0.2.0') < 0)
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  // Segment-wise, not lexicographic — 0.10.0 must beat 0.9.0.
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0)
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0)
  // A `v` prefix and build metadata are noise.
  assert.equal(compareVersions('v1.2.3', '1.2.3+ci.7'), 0)
  // Missing segments read as zero.
  assert.equal(compareVersions('1.2', '1.2.0'), 0)
})

test('compareVersions ranks a prerelease below its release', () => {
  assert.ok(compareVersions('0.2.0', '0.2.0-beta.1') > 0)
  assert.ok(compareVersions('0.2.0-beta.2', '0.2.0-beta.1') > 0)
  assert.ok(compareVersions('0.2.0-beta.1', '0.2.0-alpha.9') > 0)
})

test('isNewerVersion only fires on a genuine upgrade', () => {
  assert.equal(isNewerVersion('0.1.0', '0.2.0'), true)
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false)
  // A yanked release must never offer a downgrade.
  assert.equal(isNewerVersion('0.2.0', '0.1.0'), false)
  // Garbage in a tag reads as 0.0.0 rather than NaN, which would compare false
  // in both directions and silently wedge the check.
  assert.equal(isNewerVersion('0.1.0', 'nightly'), false)
})

const ASSETS = [
  { name: 'Carbon-0.2.0-arm64.dmg', browser_download_url: 'https://x/arm64.dmg' },
  { name: 'Carbon-0.2.0-arm64.dmg.blockmap', browser_download_url: 'https://x/arm64.blockmap' },
  { name: 'Carbon-0.2.0-x64.dmg', browser_download_url: 'https://x/x64.dmg' },
  { name: 'Carbon-0.2.0-Setup.exe', browser_download_url: 'https://x/setup.exe' },
  { name: 'Carbon-0.2.0.AppImage', browser_download_url: 'https://x/app.AppImage' }
]

test('pickAsset matches platform and arch', () => {
  assert.equal(pickAsset(ASSETS, 'darwin', 'arm64'), 'https://x/arm64.dmg')
  assert.equal(pickAsset(ASSETS, 'darwin', 'x64'), 'https://x/x64.dmg')
  assert.equal(pickAsset(ASSETS, 'win32', 'x64'), 'https://x/setup.exe')
  assert.equal(pickAsset(ASSETS, 'linux', 'x64'), 'https://x/app.AppImage')
})

test('pickAsset never hands arm64 an Intel build', () => {
  const intelOnly = [{ name: 'Carbon-0.2.0.dmg', browser_download_url: 'https://x/intel.dmg' }]
  assert.equal(pickAsset(intelOnly, 'darwin', 'arm64'), null)
  // The untagged name IS the x64 artifact under electron-builder's default.
  assert.equal(pickAsset(intelOnly, 'darwin', 'x64'), 'https://x/intel.dmg')
})

test('pickAsset ignores blockmaps and unmatched platforms', () => {
  const blockmapOnly = [
    { name: 'Carbon-0.2.0-arm64.dmg.blockmap', browser_download_url: 'https://x/bm' }
  ]
  assert.equal(pickAsset(blockmapOnly, 'darwin', 'arm64'), null)
  assert.equal(pickAsset(ASSETS, 'freebsd', 'x64'), null)
})

test('updateFromRelease reports a newer stable release', () => {
  const info = updateFromRelease(
    {
      tag_name: 'v0.2.0',
      html_url: 'https://github.com/o/r/releases/tag/v0.2.0',
      body: '  Fixes things.  ',
      published_at: '2026-08-05T10:00:00Z',
      assets: ASSETS
    },
    '0.1.0',
    'darwin',
    'arm64'
  )
  assert.deepEqual(info, {
    version: '0.2.0',
    downloadUrl: 'https://x/arm64.dmg',
    releaseUrl: 'https://github.com/o/r/releases/tag/v0.2.0',
    notes: 'Fixes things.',
    publishedAt: '2026-08-05T10:00:00Z'
  })
})

test('updateFromRelease stays quiet when there is nothing to offer', () => {
  const base = { tag_name: 'v0.2.0', assets: ASSETS }
  // Same version.
  assert.equal(updateFromRelease(base, '0.2.0', 'darwin', 'arm64'), null)
  // Older than what's installed.
  assert.equal(updateFromRelease(base, '0.3.0', 'darwin', 'arm64'), null)
  // The banner is the stable channel only.
  assert.equal(updateFromRelease({ ...base, draft: true }, '0.1.0', 'darwin', 'arm64'), null)
  assert.equal(updateFromRelease({ ...base, prerelease: true }, '0.1.0', 'darwin', 'arm64'), null)
  // A release with no tag at all.
  assert.equal(updateFromRelease({ assets: ASSETS }, '0.1.0', 'darwin', 'arm64'), null)
})

test('updateFromRelease still reports a release with no matching asset', () => {
  // Worth surfacing: the release page lists what does exist, and the banner
  // degrades to "View release" rather than vanishing.
  const info = updateFromRelease(
    { tag_name: 'v0.2.0', html_url: 'https://gh/rel', assets: [] },
    '0.1.0',
    'darwin',
    'arm64'
  )
  assert.equal(info?.version, '0.2.0')
  assert.equal(info?.downloadUrl, null)
  assert.equal(info?.releaseUrl, 'https://gh/rel')
})
