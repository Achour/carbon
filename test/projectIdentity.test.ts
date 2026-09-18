import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROJECT_HUES,
  folderName,
  projectHue,
  projectInitials
} from '../src/renderer/src/lib/projectIdentity.ts'
import { parseRemoteUrl } from '../src/main/projects.ts'

test('initials take the first letter of the first two words', () => {
  assert.equal(projectInitials('ai-gui'), 'AG')
  assert.equal(projectInitials('my_app'), 'MA')
  assert.equal(projectInitials('v2 app'), 'VA')
  assert.equal(projectInitials('@scope/pkg'), 'SP')
  assert.equal(projectInitials('three word name'), 'TW')
})

test('a single word splits on a case change, else takes two letters', () => {
  assert.equal(projectInitials('carbon'), 'CA')
  assert.equal(projectInitials('nextDoor'), 'ND')
  assert.equal(projectInitials('NextDoor'), 'ND')
  // An acronym run: the boundary is the last capital, not the first.
  assert.equal(projectInitials('AIGui'), 'AG')
  assert.equal(projectInitials('HTTPServer'), 'HS')
  assert.equal(projectInitials('app2'), 'AP')
  assert.equal(projectInitials('X'), 'X')
})

test('a nameless project still gets a mark', () => {
  assert.equal(projectInitials(''), '?')
  assert.equal(projectInitials('   '), '?')
  assert.equal(projectInitials('---'), '?')
})

test('a dotfile folder is named by its letters, not its dot', () => {
  assert.equal(projectInitials('.dotfiles'), 'DO')
})

test('the hue is stable, in range, and keyed on the path', () => {
  const a = projectHue('/Users/me/Personal/ai-gui')
  assert.equal(a, projectHue('/Users/me/Personal/ai-gui'))
  assert.ok(PROJECT_HUES.includes(a as (typeof PROJECT_HUES)[number]))
  // Renaming the display name must not move the mark — only the path is read.
  assert.notEqual(a, projectHue('/Users/me/Personal/other'))
})

test('the hues spread rather than clumping', () => {
  const seen = new Set(
    ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'].map((n) =>
      projectHue(`/p/${n}`)
    )
  )
  // Eight paths over twelve buckets: a hash that clumped would betray itself
  // here long before the UI did.
  assert.ok(seen.size >= 5, `expected a spread, got ${seen.size} distinct hues`)
})

test('folderName survives a trailing separator', () => {
  assert.equal(folderName('/a/b/c'), 'c')
  assert.equal(folderName('/a/b/c/'), 'c')
  assert.equal(folderName('C:\\dev\\thing'), 'thing')
  assert.equal(folderName('/'), '/')
})

test('scp-style remotes parse', () => {
  assert.deepEqual(parseRemoteUrl('git@github.com:Achour/carbon.git'), {
    host: 'github.com',
    owner: 'Achour',
    repo: 'carbon',
    url: 'https://github.com/Achour/carbon'
  })
})

test('https and ssh:// remotes parse, with or without .git', () => {
  assert.deepEqual(parseRemoteUrl('https://github.com/a/b'), {
    host: 'github.com',
    owner: 'a',
    repo: 'b',
    url: 'https://github.com/a/b'
  })
  assert.deepEqual(parseRemoteUrl('ssh://git@gitlab.com:2222/a/b.git'), {
    host: 'gitlab.com',
    owner: 'a',
    repo: 'b',
    url: 'https://gitlab.com/a/b'
  })
})

test('a nested group stays one owner', () => {
  assert.deepEqual(parseRemoteUrl('git@gitlab.com:group/sub/repo.git'), {
    host: 'gitlab.com',
    owner: 'group/sub',
    repo: 'repo',
    url: 'https://gitlab.com/group/sub/repo'
  })
})

test('an ssh alias gets a name but no link', () => {
  const r = parseRemoteUrl('git@github-work:me/thing.git')
  assert.equal(r?.host, 'github-work')
  assert.equal(r?.owner, 'me')
  assert.equal(r?.url, '')
})

test('remotes with no host are not repositories anyone can open', () => {
  assert.equal(parseRemoteUrl(''), null)
  assert.equal(parseRemoteUrl('   '), null)
  assert.equal(parseRemoteUrl('/srv/git/thing.git'), null)
  // A host with nothing after it names no repository.
  assert.equal(parseRemoteUrl('https://github.com/'), null)
  assert.equal(parseRemoteUrl('git@github.com:repo.git'), null)
})
