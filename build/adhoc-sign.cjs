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
const { join } = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
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
