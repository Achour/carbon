// Copy the freshly packaged Carbon.app into /Applications.
//
// This is the install path that never meets Gatekeeper. macOS attaches the
// quarantine flag when a file is *downloaded*; an app built on the machine it
// runs on was never downloaded, so nothing challenges it — no "unidentified
// developer", no `xattr`, no Apple Developer certificate. That is the whole
// reason building locally is worth the npm install.
//
// Run via `npm run install-app`, which packages first.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = '/Applications/Carbon.app'

if (process.platform !== 'darwin') {
  console.error('install-app is macOS-only. On Linux/Windows, use the installer in dist/.')
  process.exit(1)
}

// electron-builder names the output per arch: mac-arm64, mac (x64), mac-universal.
const dist = join(root, 'dist')
const built = existsSync(dist)
  ? readdirSync(dist)
      .filter((d) => d.startsWith('mac'))
      .map((d) => join(dist, d, 'Carbon.app'))
      .find((p) => existsSync(p))
  : undefined

if (!built) {
  console.error('No packaged app found in dist/. Run `npm run package` first.')
  process.exit(1)
}

// Copying over a running bundle corrupts it, and a hard kill would skip the
// store's flush-on-quit — so ask the app to quit and give it time to save.
try {
  const running = execFileSync('pgrep', ['-x', 'Carbon'], { encoding: 'utf8' }).trim()
  if (running) {
    console.log('Carbon is running — asking it to quit so its chats flush…')
    execFileSync('osascript', ['-e', 'quit app "Carbon"'])
    for (let i = 0; i < 20; i++) {
      try {
        execFileSync('pgrep', ['-x', 'Carbon'], { stdio: 'ignore' })
        execFileSync('sleep', ['1'])
      } catch {
        break // pgrep exits non-zero once nothing matches
      }
    }
  }
} catch {
  // pgrep found nothing; not running.
}

rmSync(APP, { recursive: true, force: true })
cpSync(built, APP, { recursive: true, verbatimSymlinks: true })

console.log(`Installed ${APP}`)
console.log('Open it from Spotlight or /Applications — macOS will not prompt.')
