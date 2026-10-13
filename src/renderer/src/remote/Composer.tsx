import * as React from 'react'
import { ArrowUp, ImagePlus, Square, X } from 'lucide-react'
import type { Attachment } from '@shared/types'
import { useRemote } from './state'

/** Longest side of an attached photo. A phone camera's 12 MP is wasted on a model. */
const MAX_SIDE = 2000

/**
 * Re-encode a picked photo as a JPEG no larger than `MAX_SIDE`. iOS hands the
 * page a full-resolution image (HEIC already converted), and sending that as
 * base64 over a phone connection is several megabytes per photo for no gain.
 */
async function photoAttachment(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  return {
    id: crypto.randomUUID(),
    kind: 'image',
    name: `${file.name.replace(/\.\w+$/, '') || 'photo'}.jpg`,
    mediaType: 'image/jpeg',
    data: dataUrl.replace(/^data:[^;]*;base64,/, '')
  }
}

export function Composer({
  chatId,
  busy,
  queued,
  placeholder,
  onSubmit
}: {
  chatId?: string
  busy?: boolean
  queued?: number
  placeholder?: string
  /** Replaces the default send — the new-chat screen creates the chat first. */
  onSubmit?: (text: string, attachments: Attachment[]) => Promise<void>
}): React.JSX.Element {
  const [text, setText] = React.useState('')
  const [attachments, setAttachments] = React.useState<Attachment[]>([])
  const [sending, setSending] = React.useState(false)
  const area = React.useRef<HTMLTextAreaElement>(null)
  const file = React.useRef<HTMLInputElement>(null)
  const send = useRemote((s) => s.send)
  const interrupt = useRemote((s) => s.interrupt)
  const setError = useRemote((s) => s.setError)

  // Grow with the text, up to a third of the screen.
  React.useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight / 3)}px`
  }, [text])

  const submit = async (): Promise<void> => {
    const body = text.trim()
    if ((!body && attachments.length === 0) || sending) return
    setSending(true)
    try {
      if (onSubmit) await onSubmit(body, attachments)
      else if (chatId) await send(chatId, body, attachments)
      setText('')
      setAttachments([])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="composer">
      {queued ? <div className="queued">{queued === 1 ? '1 message' : `${queued} messages`} queued — sends when this turn ends</div> : null}
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <div key={a.id} className="thumb">
              <img src={`data:${a.mediaType};base64,${a.data}`} alt={a.name} />
              <button
                type="button"
                aria-label="Remove"
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
              >
                <X />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <button type="button" className="icon-btn" aria-label="Attach photo" onClick={() => file.current?.click()}>
          <ImagePlus />
        </button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            void Promise.all(files.map(photoAttachment))
              .then((list) => setAttachments((prev) => [...prev, ...list]))
              .catch(() => setError("Couldn't read that photo."))
          }}
        />
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={placeholder ?? (busy ? 'Queue a follow-up…' : 'Message')}
          onChange={(e) => setText(e.target.value)}
        />
        {busy && chatId && !text.trim() && attachments.length === 0 ? (
          <button type="button" className="send stop" aria-label="Stop" onClick={() => void interrupt(chatId)}>
            <Square />
          </button>
        ) : (
          <button
            type="button"
            className="send"
            aria-label="Send"
            disabled={sending || (!text.trim() && attachments.length === 0)}
            onClick={() => void submit()}
          >
            <ArrowUp />
          </button>
        )}
      </div>
    </div>
  )
}
