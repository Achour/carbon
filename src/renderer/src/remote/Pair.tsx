import * as React from 'react'
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

  const submit = React.useCallback(
    async (value: string): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        await api.pair(value, api.deviceName())
        onPaired()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
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
    <div className="screen center pair">
      <div className="pair-mark">C</div>
      <h1>Pair with Carbon</h1>
      <p className="muted">
        On your Mac, open Carbon → Settings → Remote access and tap “Pair a phone”. Then enter the
        six-digit code here.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (code.length === 6) void submit(code)
        }}
      >
        <input
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          placeholder="000000"
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          autoFocus
        />
        <button className="btn primary wide" type="submit" disabled={busy || code.length !== 6}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
