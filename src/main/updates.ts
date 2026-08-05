import { app } from 'electron'
import type { UpdateInfo } from '@shared/types'
import { updateFromRelease, type ReleaseJson } from './updateCheck'

/**
 * Update *notification*, not auto-install.
 *
 * Carbon ships unsigned, and macOS refuses to apply an `electron-updater`
 * download to an app without a Developer ID signature — so silent in-place
 * updates are off the table until there's a cert. What still works everywhere
 * is asking GitHub what the newest release is and pointing the user at it; the
 * renderer shows a banner and opens the `.dmg` link. That is also what the
 * comparable apps actually ship today (Mission Control has `electron-updater`
 * wired but dark, falling back to opening the download URL).
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
