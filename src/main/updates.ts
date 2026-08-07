import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { UpdateInfo } from '@shared/types'
import { updateFromRelease, type ReleaseJson } from './updateCheck'

/**
 * Update *notification*, not auto-install.
 *
 * Carbon ships unsigned, and macOS refuses to apply an `electron-updater`
 * download to an app without a Developer ID signature — the ad-hoc signature in
 * `build/adhoc-sign.cjs` gives every build a designated requirement of
 * `cdhash H"…"`, a literal hash of that one build, so Squirrel.Mac's check that
 * the update matches the installed app can never pass. Silent in-place updates
 * are off the table until there's a cert. What still works everywhere is asking
 * GitHub what the newest release is and pointing the user at it.
 *
 * The one install route that *does* update in place is the Homebrew cask, which
 * is why `installedViaHomebrew` exists — see below.
 *
 * The release layout this reads — one GitHub Release per version, installers
 * attached as assets — is exactly what `electron-updater` wants too, so
 * swapping this for real auto-update later changes the client and nothing else.
 */

/** The one place the published repo is named. */
const REPO = process.env.CARBON_UPDATE_REPO || 'Achour/carbon'

/** Long enough that a background check never looks like a hang. */
const TIMEOUT_MS = 10_000

/** GitHub serves this unauthenticated at 60 req/hr/IP — far above our rate. */
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`

let inFlight: Promise<UpdateInfo | null> | null = null

async function fetchLatest(): Promise<UpdateInfo | null> {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const res = await fetch(LATEST_RELEASE_URL, {
    signal,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Carbon/${app.getVersion()}`
    }
  })
  // 404 is the normal answer before the first release exists — not an error
  // worth surfacing, just "nothing newer".
  if (!res.ok) return null

  const release = (await res.json()) as ReleaseJson
  return updateFromRelease(release, app.getVersion(), process.platform, process.arch)
}

/**
 * The newest published release when it is newer than the running build, else
 * null. Never throws — a failed check is indistinguishable from "up to date"
 * as far as the UI is concerned, and an offline user should see neither an
 * error nor a banner.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // Boot and the periodic timer can land together; one request answers both.
  if (inFlight) return inFlight
  inFlight = fetchLatest().catch(() => null)
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

/** The cask's token in `Achour/homebrew-carbon`; also its Caskroom directory. */
const CASK_TOKEN = 'carbon'

/**
 * Homebrew's prefix per architecture, plus an explicit override for a relocated
 * install. Deliberately *not* `brew --prefix`: a GUI app inherits no shell PATH,
 * so shelling out would fail on exactly the machines this needs to work on.
 */
const HOMEBREW_PREFIXES = [process.env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local']

let homebrew: boolean | undefined

/**
 * Was the running build installed by the Homebrew cask?
 *
 * It matters because brew is the one route that updates itself in place, so it
 * gets a different instruction than everyone else — and the wrong instruction is
 * actively harmful either way. Sending a brew user to the `.dmg` leaves
 * Homebrew's records describing a version that is no longer on disk, and the
 * next `brew upgrade` overwrites their hand-installed copy; sending a
 * non-brew user to `brew upgrade` just errors.
 *
 * Homebrew stages every cask into `<prefix>/Caskroom/<token>/<version>` and
 * keeps that directory for as long as the cask is installed — it is public
 * (`brew --caskroom` names it), so its existence is the whole signal. Matching
 * on the *running* version rather than the token alone is what keeps the answer
 * honest when someone brew-installs and then builds a newer copy over the top:
 * the versions diverge, this says no, and they get the generic banner.
 *
 * Every failure mode here is a false negative — an unrecognized layout, a
 * custom `--appdir` — which costs a brew user the tailored message and nothing
 * else. That asymmetry is the reason each check is a hard requirement rather
 * than one signal among several.
 */
export function installedViaHomebrew(): boolean {
  if (homebrew === undefined) homebrew = detectHomebrew()
  return homebrew
}

function detectHomebrew(): boolean {
  // The brew banner is otherwise only reachable from an actual cask install,
  // which no dev run can be. Dev-only on purpose: a packaged build ignores it.
  if (!app.isPackaged && process.env.CARBON_FAKE_HOMEBREW) return true

  // A dev run executes out of node_modules/electron, and `npm run package`
  // leaves a build in dist/ — in both cases whatever sits in /Applications is a
  // different copy whose install route says nothing about this one.
  if (process.platform !== 'darwin' || !app.isPackaged) return false
  if (!app.getPath('exe').startsWith('/Applications/Carbon.app/')) return false

  return HOMEBREW_PREFIXES.some(
    (prefix) => prefix && existsSync(join(prefix, 'Caskroom', CASK_TOKEN, app.getVersion()))
  )
}
