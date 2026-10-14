import { execFile as execFileCb } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { promisify } from 'node:util'
import { isExecutable, onPath } from './providerCli'
import { certDomainFromStatus, splitCertOutput } from './remoteNet.ts'

const execFile = promisify(execFileCb)

/**
 * The certificate that puts the phone client on HTTPS.
 *
 * Web Push needs a secure context, and the phone reaches the Mac over plain
 * HTTP. Tailscale's `tailscale cert` issues a real Let's Encrypt certificate
 * for the Mac's `<name>.<tailnet>.ts.net` name, free, with nothing for the
 * phone to trust by hand — so Carbon asks the user's own Tailscale for it,
 * the way it asks the user's own CLIs for everything else.
 *
 * Both halves go to stdout (`-`), never to a file: the App Store build's CLI
 * runs sandboxed, and a path Carbon names would be written into Tailscale's
 * container instead. See `docs/remote.md`.
 */

export type CertResult =
  | { ok: true; name: string; cert: string; key: string; expiresAt: number }
  | { ok: false; reason: string }

/** The first issuance runs an ACME challenge; later calls answer from Tailscale's cache. */
const CERT_TIMEOUT_MS = 120_000

/**
 * The CLI, in the order a terminal would find it, then where each of
 * Tailscale's installers puts it. The App Store and standalone apps carry it
 * inside the bundle, where it runs as the CLI only with `TAILSCALE_BE_CLI`.
 */
export function tailscaleBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CARBON_TAILSCALE_PATH) return isExecutable(env.CARBON_TAILSCALE_PATH) ? env.CARBON_TAILSCALE_PATH : null
  return (
    onPath('tailscale', env) ??
    [
      '/usr/local/bin/tailscale',
      '/opt/homebrew/bin/tailscale',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    ].find(isExecutable) ??
    null
  )
}

async function run(bin: string, args: string[], timeout: number): Promise<string> {
  const { stdout } = await execFile(bin, args, {
    timeout,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, TAILSCALE_BE_CLI: '1' }
  })
  return stdout
}

/** One line of a CLI failure, without Go's usage dump. */
function cliError(err: unknown): string {
  const e = err as { stderr?: string; message?: string; killed?: boolean }
  if (e.killed) return 'Tailscale took too long to issue the certificate. Carbon will try again.'
  const line = (e.stderr || e.message || String(err)).trim().split('\n').find((l) => l.trim()) ?? ''
  return line.length > 240 ? `${line.slice(0, 240)}…` : line
}

export async function fetchTailscaleCert(): Promise<CertResult> {
  const bin = tailscaleBinary()
  if (!bin) return { ok: false, reason: 'Tailscale is not installed on this Mac.' }
  let status: string
  try {
    status = await run(bin, ['status', '--json'], 10_000)
  } catch (err) {
    // A stopped node still prints its status; a failure here is the daemon itself.
    const out = (err as { stdout?: string }).stdout
    if (!out) return { ok: false, reason: `Tailscale did not answer: ${cliError(err)}` }
    status = out
  }
  const found = certDomainFromStatus(status)
  if ('reason' in found) return { ok: false, reason: found.reason }
  let out: string
  try {
    out = await run(bin, ['cert', '--cert-file', '-', '--key-file', '-', found.domain], CERT_TIMEOUT_MS)
  } catch (err) {
    return { ok: false, reason: `Tailscale could not issue a certificate: ${cliError(err)}` }
  }
  const pair = splitCertOutput(out)
  if (!pair) return { ok: false, reason: 'Tailscale returned no certificate.' }
  let expiresAt: number
  try {
    expiresAt = Date.parse(new X509Certificate(pair.cert).validTo)
  } catch {
    return { ok: false, reason: 'Tailscale returned a certificate Carbon could not read.' }
  }
  return { ok: true, name: found.domain, ...pair, expiresAt }
}
