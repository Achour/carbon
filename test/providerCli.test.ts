import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  compareVersions,
  configureProviderClis,
  parseVersion,
  providerCli
} from '../src/main/providerCli.ts'

/** A stub binary that is executable, so resolution treats it as a real install. */
function fakeBinary(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\necho "stub 9.9.9"\n')
  chmodSync(path, 0o755)
  return path
}

test('a version is read out of whatever shape the CLI prints', () => {
  // The three real formats: bare, prefixed, and suffixed with a build hash.
  assert.equal(parseVersion('2.1.238 (Claude Code)'), '2.1.238')
  assert.equal(parseVersion('codex-cli 0.149.0'), '0.149.0')
  assert.equal(parseVersion('grok 1.0.5 (5115b46bc909) [stable]'), '1.0.5')
  assert.equal(parseVersion('no version here'), null)
})

test('versions compare numerically, not as strings', () => {
  // The case a lexical compare gets wrong, and the reason this exists.
  assert.equal(compareVersions('2.10.0', '2.9.0') > 0, true)
  assert.equal(compareVersions('0.140.0', '0.99.0') > 0, true)
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
})

test('an env override is reported as itself when nothing is there', () => {
  // Silently falling back to a binary on PATH would make a typo look like a
  // working override, so one that resolves to nothing has to surface.
  const info = providerCli('claude', {
    CARBON_CLAUDE_PATH: '/definitely/not/here/claude',
    PATH: '',
    HOME: '/nonexistent'
  })
  assert.equal(info.path, '/definitely/not/here/claude')
  assert.equal(info.installed, false)
  assert.equal(info.source, 'configured')
})

test('an env override outranks a real install on PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'carbon-cli-'))
  fakeBinary(join(root, 'bin'), 'codex')
  const info = providerCli('codex', {
    CARBON_CODEX_PATH: '/pinned/codex',
    PATH: join(root, 'bin'),
    HOME: root
  })
  assert.equal(info.path, '/pinned/codex')
})

test('PATH wins over the installers’ known locations', () => {
  // A version manager's shim is what the user's terminal would run; the known
  // locations only answer when PATH doesn't.
  const root = mkdtempSync(join(tmpdir(), 'carbon-cli-'))
  const onPath = fakeBinary(join(root, 'shims'), 'codex')
  fakeBinary(join(root, 'home', '.local', 'bin'), 'codex')

  const info = providerCli('codex', {
    PATH: join(root, 'shims'),
    HOME: join(root, 'home')
  })
  assert.equal(info.path, onPath)
  assert.equal(info.source, 'path')
  assert.equal(info.installed, true)
})

test('a known install location answers when PATH does not', () => {
  // The Dock-launch case: no inherited PATH, but the CLI is where its own
  // installer put it.
  const root = mkdtempSync(join(tmpdir(), 'carbon-cli-'))
  const known = fakeBinary(join(root, 'home', '.grok', 'bin'), 'grok')

  const info = providerCli('grok', { PATH: '', HOME: join(root, 'home') })
  assert.equal(info.path, known)
  assert.equal(info.source, 'known')
})

test('a switched-off provider still reports what it found', () => {
  // The row has to show the version of a provider you turned off, otherwise
  // turning it back on is a leap of faith.
  const root = mkdtempSync(join(tmpdir(), 'carbon-cli-'))
  fakeBinary(join(root, 'bin'), 'claude')
  configureProviderClis({ claude: { enabled: false } })

  const info = providerCli('claude', { PATH: join(root, 'bin'), HOME: root })
  assert.equal(info.enabled, false)
  assert.equal(info.installed, true)
  configureProviderClis({})
})
