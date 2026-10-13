import * as React from 'react'
import { useRemote } from './state'
import * as api from './api'
import { ChatList } from './ChatList'
import { ChatScreen } from './ChatScreen'
import { NewChatScreen } from './NewChat'
import { PairScreen } from './Pair'

/**
 * Routes live in the hash — `#/`, `#/c/<id>`, `#/new` — so a reload, or iOS
 * restoring a Home Screen app, lands where the user was. `#pair=<code>` is the
 * QR code's link: it pre-fills the pairing screen and is then dropped.
 */
type Route = { name: 'list' } | { name: 'chat'; id: string } | { name: 'new' }

function readRoute(): Route {
  const h = location.hash
  const chat = /^#\/c\/(.+)$/.exec(h)
  if (chat) return { name: 'chat', id: decodeURIComponent(chat[1]) }
  if (h === '#/new') return { name: 'new' }
  return { name: 'list' }
}

export function navigate(hash: string): void {
  if (location.hash !== hash) location.hash = hash
}

export function App(): React.JSX.Element {
  const [route, setRoute] = React.useState<Route>(readRoute)
  const [pairCode] = React.useState(() => /^#pair=(\d+)/.exec(location.hash)?.[1] ?? null)
  const [paired, setPaired] = React.useState<boolean | null>(null)
  const connection = useRemote((s) => s.connection)

  React.useEffect(() => {
    if (pairCode) history.replaceState(null, '', '/#/')
    const onHash = (): void => {
      // A pairing link opened onto a page already showing: start over with it.
      if (location.hash.startsWith('#pair=')) location.reload()
      else setRoute(readRoute())
    }
    window.addEventListener('hashchange', onHash)
    void api
      .paired()
      .then(setPaired)
      .catch(() => setPaired(false))
    return () => window.removeEventListener('hashchange', onHash)
  }, [pairCode])

  React.useEffect(() => {
    if (paired) useRemote.getState().start()
  }, [paired])

  const openId = route.name === 'chat' ? route.id : null
  React.useEffect(() => {
    if (paired) void useRemote.getState().openChat(openId)
  }, [paired, openId])

  if (paired === null) return <div className="screen center muted">Connecting…</div>
  if (!paired || connection === 'unpaired') {
    return <PairScreen initialCode={pairCode ?? ''} onPaired={() => location.reload()} />
  }

  return (
    <>
      <ErrorToast />
      {route.name === 'chat' ? (
        <ChatScreen chatId={route.id} />
      ) : route.name === 'new' ? (
        <NewChatScreen />
      ) : (
        <ChatList />
      )}
    </>
  )
}

function ErrorToast(): React.JSX.Element | null {
  const error = useRemote((s) => s.error)
  const setError = useRemote((s) => s.setError)
  React.useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 6000)
    return () => clearTimeout(t)
  }, [error, setError])
  if (!error) return null
  return (
    <button type="button" className="toast" onClick={() => setError(null)}>
      {error}
    </button>
  )
}

/** The thin strip that says the Mac is not answering, and that it is retrying. */
export function ConnectionStrip(): React.JSX.Element | null {
  const connection = useRemote((s) => s.connection)
  if (connection === 'live') return null
  return (
    <div className={`strip ${connection === 'down' ? 'warn' : ''}`}>
      {connection === 'down' ? "Can't reach your Mac — retrying…" : 'Connecting…'}
    </div>
  )
}
