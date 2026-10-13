// Ad-hoc code signature for the packaged macOS app.
//
// Carbon ships without a Developer ID certificate, so `mac.identity: null` in
// electron-builder.yml turns signing off entirely. On Intel that is fine — an
// unsigned binary still execs. On Apple Silicon it is not: the kernel refuses
// to run an arm64 binary carrying *no* signature at all, and the app dies at
// launch with "killed: 9" rather than any dialog a user could act on.
//
// `codesign --sign -` writes an ad-hoc signature: a real, verifiable signature
// bound to no identity. It costs nothing, needs no Apple account, and is the
// minimum macOS requires to exec. It is emphatically NOT notarization — the
// first-launch Gatekeeper prompt is unaffected (see README).
//
// Order matters: `--deep` signs nested code from the inside out, and the outer
// bundle must be signed last or its seal won't cover the frameworks. `--force`
// replaces the signature Electron's own prebuilt binary arrives with, which our
// repackaging has already invalidated.

const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

// electron-builder's `Arch` enum, by value — read off `builder-util` rather
// than imported, so this hook keeps no dependency of its own.
const ARCH = { 1: 'x64', 3: 'arm64' }

/**
 * Cursor's helpers must be where its SDK walks to (see `extraFiles` in
 * electron-builder.yml). Not fatal when missing — Cursor still loads and only
 * its tools fail to spawn — so a release built without
 * `scripts/cursor-sdk-platforms.mjs` says so loudly instead.
 */
function checkCursorPlatform(appPath, arch) {
  const want = ARCH[arch]
  if (!want) return
  const dir = join(appPath, 'Contents', 'node_modules', '@cursor', `sdk-darwin-${want}`, 'bin', 'cursorsandbox')
  if (!existsSync(dir)) {
    console.warn(`  • WARNING: @cursor/sdk-darwin-${want} missing; run scripts/cursor-sdk-platforms.mjs`)
  }
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  checkCursorPlatform(
    join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    context.arch
  )
  // A real identity means electron-builder is doing the signing properly; never
  // stomp on it. (If a certificate ever appears, this hook goes quiet on its own.)
  if (process.env.CSC_LINK || process.env.CSC_NAME) return

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  // Verify rather than trust: a silent signing failure here surfaces as an
  // un-launchable download, which is the worst possible place to find out.
  execFileSync('codesign', ['--verify', '--deep', appPath], { stdio: 'inherit' })

  console.log(`  • ad-hoc signed ${appPath}`)
}
