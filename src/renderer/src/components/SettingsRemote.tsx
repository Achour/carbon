import * as React from 'react'
import QRCode from 'qrcode'
import { Copy, Smartphone, Trash2, TriangleAlert } from 'lucide-react'
import type { RemoteAccessState } from '@shared/types'
import { relativeTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { SwitchPill } from '@/components/ui/switch-pill'

/**
 * Settings → Remote access: Carbon from a phone.
 *
 * Main serves a phone-sized client and relays the conversation channels to it
 * (`main/remoteAccess.ts`); this page is the switch, the address, the pairing
 * code and the list of phones that hold a key. Pairing is a QR code for the
 * phone's camera and the same six digits for typing, because the camera is the
 * fast path and typing is the one that always works.
 */
export function RemoteSection(): React.JSX.Element {
  const [state, setState] = React.useState<RemoteAccessState | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let live = true
    const load = (): void => {
      void window.api.remoteState().then((s) => live && setState(s))
    }
    load()
    const off = window.api.onRemoteChanged(load)
    return () => {
      live = false
      off()
    }
  }, [])

  const run = async (fn: () => Promise<RemoteAccessState>): Promise<void> => {
    setBusy(true)
    try {
      setState(await fn())
    } finally {
      setBusy(false)
    }
  }

  if (!state) return <div />

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-4 px-2 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Use Carbon from your phone</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Read chats as they stream, send messages and answer approvals from your phone's browser.
            Agents keep running here, so this Mac has to stay on.
          </div>
        </div>
        <SwitchPill
          on={state.enabled}
          disabled={busy}
          label="Remote access"
          onChange={() => void run(() => window.api.remoteConfigure({ enabled: !state.enabled }))}
        />
      </div>

      {state.error && (
        <div className="mx-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span>{state.error}</span>
        </div>
      )}

      {state.enabled && state.running && (
        <>
          <Address state={state} />
          <Pairing state={state} busy={busy} onPair={() => void run(() => window.api.remotePair())} />
        </>
      )}

      <div className="mx-2 my-3 border-t border-border" />

      <div className="flex items-center gap-4 px-2 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Allow the local network</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Also accept phones on this Wi-Fi, not only over Tailscale. Traffic on the local network
            is not encrypted, so leave this off on networks you don't trust.
          </div>
        </div>
        <SwitchPill
          on={state.allowLan}
          disabled={busy}
          label="Allow the local network"
          onChange={() => void run(() => window.api.remoteConfigure({ allowLan: !state.allowLan }))}
        />
      </div>

      <Devices state={state} onForget={(id) => void run(() => window.api.remoteForget(id))} />
    </div>
  )
}

function Address({ state }: { state: RemoteAccessState }): React.JSX.Element {
  if (state.urls.length === 0) {
    return (
      <div className="mx-2 rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">No Tailscale connection found</div>
        Install Tailscale on this Mac and on your phone, sign both into the same account, and the
        address appears here. Or turn on “Allow the local network” to use it on this Wi-Fi only.
      </div>
    )
  }
  return (
    <div className="space-y-1 px-2 py-1">
      {state.urls.map((u) => (
        <div key={u.url} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 text-muted-foreground">
            {u.kind === 'tailscale' ? 'Tailscale' : 'This Wi-Fi'}
          </span>
          <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{u.url}</code>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy address"
            onClick={() => void navigator.clipboard.writeText(u.url)}
          >
            <Copy />
          </Button>
        </div>
      ))}
    </div>
  )
}

function Pairing({
  state,
  busy,
  onPair
}: {
  state: RemoteAccessState
  busy: boolean
  onPair: () => void
}): React.JSX.Element | null {
  const pairing = state.pairing
  const link = pairing?.links[0]
  const [svg, setSvg] = React.useState<string | null>(null)
  const [, tick] = React.useReducer((n: number) => n + 1, 0)

  React.useEffect(() => {
    if (!link) return setSvg(null)
    let live = true
    void QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
      (out) => live && setSvg(out)
    )
    return () => {
      live = false
    }
  }, [link])

  // Re-render each second so the countdown moves and an expired code goes away.
  React.useEffect(() => {
    if (!pairing) return
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [pairing])

  if (state.urls.length === 0) return null
  const left = pairing ? Math.max(0, pairing.expiresAt - Date.now()) : 0

  if (!pairing || left === 0) {
    return (
      <div className="flex items-center gap-4 px-2 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Pair a phone</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Shows a QR code and a six-digit code. Each code works once, for ten minutes.
          </div>
        </div>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onPair}>
          <Smartphone /> Pair a phone
        </Button>
      </div>
    )
  }

  const minutes = Math.floor(left / 60_000)
  const seconds = Math.floor((left % 60_000) / 1000)
  return (
    <div className="mx-2 flex gap-4 rounded-lg border border-border bg-secondary/40 p-3">
      {svg && (
        <div
          className="size-36 shrink-0 overflow-hidden rounded-md bg-white p-1 [&>svg]:size-full"
          // Generated locally from the pairing link, never from anything a peer sent.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      <div className="min-w-0 flex-1 text-xs">
        <div className="text-[13px] font-medium">Scan with your phone's camera</div>
        <div className="mt-1 text-muted-foreground">
          Or open <code className="font-mono text-foreground">{state.urls[0].url}</code> and enter:
        </div>
        <div className="mt-2 font-mono text-2xl font-semibold tracking-[0.3em]">{pairing.code}</div>
        <div className="mt-2 text-muted-foreground">
          Expires in {minutes}:{String(seconds).padStart(2, '0')}. Then tap Share → Add to Home
          Screen to keep Carbon one tap away.
        </div>
      </div>
    </div>
  )
}

/** `relativeTime`'s compact "5m" / "Mar 3", made to read inside a sentence. */
function ago(ts: number): string {
  const t = relativeTime(ts)
  if (t === 'now') return 'just now'
  return /^\d+[mhd]$/.test(t) ? `${t} ago` : `on ${t}`
}

function Devices({
  state,
  onForget
}: {
  state: RemoteAccessState
  onForget: (id?: string) => void
}): React.JSX.Element | null {
  if (state.devices.length === 0) return null
  return (
    <div className="pt-2">
      <div className="flex items-center px-2 pb-1">
        <div className="flex-1 text-[13px] font-medium">Paired devices</div>
        {state.devices.length > 1 && (
          <Button variant="ghost" size="sm" onClick={() => onForget()}>
            Unpair all
          </Button>
        )}
      </div>
      {state.devices.map((d) => (
        <div key={d.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/40">
          <Smartphone className="size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px]">{d.name}</div>
            <div className="text-xs text-muted-foreground">
              Paired {ago(d.pairedAt)}
              {d.lastSeenAt ? ` · last used ${ago(d.lastSeenAt)}` : ''}
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={`Unpair ${d.name}`} onClick={() => onForget(d.id)}>
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  )
}
