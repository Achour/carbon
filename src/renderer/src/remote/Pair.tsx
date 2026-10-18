import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import * as api from './api'

export function PairScreen({
  initialCode,
  onPaired
}: {
  initialCode: string
  onPaired: () => void
}): React.JSX.Element {
  const [code, setCode] = React.useState(initialCode)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const input = React.useRef<HTMLInputElement>(null)

  const submit = React.useCallback(
    async (value: string): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        await api.pair(value, api.deviceName())
        onPaired()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setCode('')
        setBusy(false)
        input.current?.focus()
      }
    },
    [onPaired]
  )

  // The QR code's link carries the code: pair straight away.
  const auto = React.useRef(false)
  React.useEffect(() => {
    if (initialCode.length === 6 && !auto.current) {
      auto.current = true
      void submit(initialCode)
    }
  }, [initialCode, submit])

  return (
    <div className="flex h-[var(--kb-height,var(--app-height,100dvh))] flex-col items-center justify-center px-8 pb-[12dvh] text-center">
      <img src="/remote-icon.png" alt="" className="mb-6 size-16 rounded-[18px] shadow-md" />
      <h1 className="text-[24px] font-semibold tracking-tight">Connect to Carbon</h1>
      <p className="mt-2 max-w-[19rem] text-[15px] leading-snug text-muted-foreground">
        On your Mac, open Settings → Remote access, tap <span className="text-foreground">Pair a phone</span>, and
        enter the code.
      </p>
      <form
        className="mt-8 w-full max-w-[20rem]"
        onSubmit={(e) => {
          e.preventDefault()
          if (code.length === 6) void submit(code)
        }}
      >
        <label className="relative block">
          <input
            ref={input}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            autoFocus
            disabled={busy}
            aria-label="Pairing code"
            onChange={(e) => {
              const next = e.target.value.replace(/\D/g, '').slice(0, 6)
              setCode(next)
              if (next.length === 6) void submit(next)
            }}
            className="absolute inset-0 opacity-0"
          />
          <div className="pointer-events-none grid grid-cols-6 gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className={cn(
                  'flex h-14 items-center justify-center rounded-xl border bg-card font-mono text-[24px] transition-colors',
                  i === code.length && !busy ? 'border-foreground/50' : 'border-border',
                  error && 'border-destructive/50'
                )}
              >
                {code[i] ?? ''}
              </div>
            ))}
          </div>
        </label>
      </form>
      <div className="mt-5 h-6 text-[14px]">
        {busy ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : error ? (
          <span className="text-destructive">{error}</span>
        ) : null}
      </div>
    </div>
  )
}
