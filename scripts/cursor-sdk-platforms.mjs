// Put both macOS platform packages of @cursor/sdk into node_modules.
//
// The SDK finds its sandbox helper, `rg` and tree-sitter in a sibling package,
// `@cursor/sdk-<platform>-<arch>`, and npm installs only the one matching the
// machine it runs on. Carbon builds an arm64 *and* an x64 dmg from one Apple
// Silicon runner, so without this the x64 app would ship the arm64 helpers and
// every Cursor tool call on an Intel Mac would fail to spawn. `extraFiles` in
// electron-builder.yml then copies each dmg's own into `Contents/node_modules`.
//
// Fetched with `npm pack` at the exact version of the installed SDK and
// unpacked in place: `npm install --cpu` would rewrite the lockfile and re-run
// every install script, for what is two directories of prebuilt files.
//
// Run by `npm run package` and the release workflow; a no-op when both exist.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scope = join(root, 'node_modules', '@cursor')
const sdk = JSON.parse(readFileSync(join(scope, 'sdk', 'package.json'), 'utf8'))

for (const arch of ['arm64', 'x64']) {
  const name = `sdk-darwin-${arch}`
  const dest = join(scope, name)
  if (existsSync(join(dest, 'package.json'))) {
    const have = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).version
    if (have === sdk.version) continue
    rmSync(dest, { recursive: true, force: true })
  }
  const work = mkdtempSync(join(tmpdir(), 'cursor-sdk-'))
  try {
    const spec = `@cursor/${name}@${sdk.version}`
    const tarball = execFileSync('npm', ['pack', spec, '--silent', '--pack-destination', work], {
      encoding: 'utf8'
    }).trim()
    execFileSync('tar', ['-xzf', join(work, tarball.split('\n').pop()), '-C', work])
    mkdirSync(scope, { recursive: true })
    renameSync(join(work, 'package'), dest)
    console.log(`  • ${spec} → node_modules/@cursor/${name}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
