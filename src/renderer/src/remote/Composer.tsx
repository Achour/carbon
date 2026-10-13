import * as React from 'react'
import { ArrowUp, Paperclip, Square, X } from 'lucide-react'
import type { Attachment } from '@shared/types'
import { cn } from '@/lib/utils'
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

/**
 * The phone's composer, shaped like the desktop's: one card holding the text,
 * the photos, and a footer of controls — attach, the option chips (`tools`),
 * send. While a turn runs an empty composer offers Stop; anything typed is
 * queued behind the turn instead.
 */
export function Composer({
  chatId,
  busy,
  queued,
  placeholder,
  tools,
  above,
  autoFocus,
  onSubmit
}: {
  chatId?: string
  busy?: boolean
  queued?: number
  placeholder?: string
  /** The option chips, drawn in the footer between attach and send. */
  tools?: React.ReactNode
  /** A line above the card — a pending model switch, the project chip. */
  above?: React.ReactNode
  autoFocus?: boolean
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

  const empty = !text.trim() && attachments.length === 0
  const submit = async (): Promise<void> => {
    if (empty || sending) return
    setSending(true)
    try {
      if (onSubmit) await onSubmit(text.trim(), attachments)
      else if (chatId) await send(chatId, text.trim(), attachments)
      setText('')
      setAttachments([])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }
  const stop = busy && chatId && empty

  return (
    <div className="shrink-0 px-3 pt-1 pb-[max(env(safe-area-inset-bottom),10px)]">
      {queued ? (
        <div className="px-2 pb-1.5 text-[13px] text-muted-foreground">
          {queued === 1 ? '1 message' : `${queued} messages`} queued — sends when this turn ends
        </div>
      ) : null}
      {above}
      <div className="rounded-[22px] border border-border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_16px_rgb(0_0_0/0.06)] dark:shadow-none">
        {attachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {attachments.map((a) => (
              <div key={a.id} className="relative size-16 shrink-0">
                <img
                  src={`data:${a.mediaType};base64,${a.data}`}
                  alt={a.name}
                  className="size-16 rounded-xl border border-border object-cover"
                />
                <button
                  type="button"
                  aria-label="Remove"
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background"
                  onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          placeholder={placeholder ?? (busy ? 'Queue a follow-up…' : 'Message')}
          onChange={(e) => setText(e.target.value)}
          className="block max-h-[33dvh] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[16px] leading-[1.45] outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <button
            type="button"
            aria-label="Attach photo"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
            onClick={() => file.current?.click()}
          >
            <Paperclip className="size-[17px]" />
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
          {tools ?? <div className="flex-1" />}
          {stop ? (
            <button
              type="button"
              aria-label="Stop"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background active:opacity-80"
              onClick={() => void interrupt(chatId)}
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              disabled={sending || empty}
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full transition-colors',
                empty ? 'bg-muted text-muted-foreground' : 'bg-foreground text-background active:opacity-80'
              )}
              onClick={() => void submit()}
            >
              <ArrowUp className="size-[18px]" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
