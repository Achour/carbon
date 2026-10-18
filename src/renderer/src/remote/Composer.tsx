import * as React from 'react'
import { ArrowUp, Clock, FileText, Paperclip, Square, X } from 'lucide-react'
import type { Attachment } from '@shared/types'
import { PROVIDER_SHORT_LABELS, type Provider } from '@shared/types'
import { randomId } from '@/lib/insecureContext'
import { cn } from '@/lib/utils'
import { ContextDetail } from '@/components/ContextDetail'
import { useRemote, type QueuedMessage } from './state'
import { Sheet } from './Sheet'
import * as api from './api'

/** Longest side of an attached photo. A phone camera's 12 MP is wasted on a model. */
const MAX_SIDE = 2000

/** What the model accepts as-is, for the fallback that sends the file untouched. */
const SENDABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
/** The API's per-image cap is 5 MB of base64, which is ~3.75 MB of bytes. */
const MAX_RAW_BYTES = 3_700_000

/**
 * Decode through an `<img>`, not `createImageBitmap`. The bitmap is a
 * full-resolution decode, and iOS Safari refuses one the size of a recent
 * iPhone photo (48 MP is ~190 MB of pixels) — which failed every pick on the
 * phone. An image element is what Safari has always decoded large photos for.
 */
async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; done(): void }> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) }
  } catch {
    URL.revokeObjectURL(url)
    const bitmap = await createImageBitmap(file)
    return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() }
  }
}

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;base64,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * Re-encode a picked photo as a JPEG no larger than `MAX_SIDE`. iOS hands the
 * page a full-resolution image (HEIC already converted), and sending that as
 * base64 over a phone connection is several megabytes per photo for no gain.
 * A photo that cannot be decoded here is sent as it is, when the model can
 * read its type and it is small enough.
 */
async function photoAttachment(file: File): Promise<Attachment> {
  const base = file.name.replace(/\.\w+$/, '') || 'photo'
  try {
    const image = await decode(file)
    try {
      const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))
      canvas.getContext('2d')!.drawImage(image.source, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
      if (!dataUrl.startsWith('data:image/jpeg')) throw new Error('Could not encode the photo.')
      return {
        id: randomId(),
        kind: 'image',
        name: `${base}.jpg`,
        mediaType: 'image/jpeg',
        data: dataUrl.replace(/^data:[^;]*;base64,/, '')
      }
    } finally {
      image.done()
    }
  } catch (err) {
    if (!SENDABLE.has(file.type) || file.size > MAX_RAW_BYTES) throw err
    return { id: randomId(), kind: 'image', name: file.name || base, mediaType: file.type, data: await base64Of(file) }
  }
}

/**
 * What a picked, pasted or dropped file becomes. A photo is shrunk and sent
 * inline (`photoAttachment`); anything else is written to the Mac and attached
 * by path, which is how the desktop attaches a dropped file — the agent reads
 * it there.
 */
async function fileAttachment(file: File): Promise<Attachment> {
  if (file.type.startsWith('image/')) return photoAttachment(file)
  if (file.size > api.MAX_UPLOAD_BYTES) throw new Error(`${file.name || 'That file'} is over 25 MB`)
  const { path, name } = await api.upload(file)
  return { id: randomId(), kind: 'file', name, path }
}

/** Files on a paste or a drop: the list, or the items when only they carry them. */
function filesOf(data: DataTransfer | null): File[] {
  if (!data) return []
  if (data.files.length) return [...data.files]
  return [...data.items].filter((i) => i.kind === 'file').flatMap((i) => i.getAsFile() ?? [])
}

const NO_QUEUE: QueuedMessage[] = []

/**
 * Send and Stop never take the focus. Taking it closed the keyboard on the
 * tap itself, the composer dropped with it, and the click landed where the
 * button had been: one tap closed the keyboard, a second one sent. The tap
 * keeps the focus; sending then closes the keyboard itself (`submit`).
 */
const keepKeyboard = (e: React.MouseEvent): void => e.preventDefault()

/**
 * The phone's composer, shaped like the desktop's: one card holding the text,
 * the photos, and a footer of controls — attach, the option chips (`tools`),
 * send. While a turn runs an empty composer offers Stop; anything typed is
 * queued behind the turn instead, and listed above the card with Send now,
 * which interrupts the turn for it, the way the desktop's queue does.
 */
export function Composer({
  chatId,
  busy,
  placeholder,
  tools,
  above,
  autoFocus,
  context,
  onSubmit
}: {
  chatId?: string
  busy?: boolean
  placeholder?: string
  /** The option chips, drawn in the footer between attach and send. */
  tools?: React.ReactNode
  /** A line above the card — a pending model switch, the project chip. */
  above?: React.ReactNode
  autoFocus?: boolean
  /** The chat's context window, drawn as the desktop composer's ring. */
  context?: { used: number; window: number; provider: Provider; chatId: string }
  /** Replaces the default send — the new-chat screen creates the chat first. */
  onSubmit?: (text: string, attachments: Attachment[]) => Promise<void>
}): React.JSX.Element {
  const [text, setText] = React.useState('')
  const [attachments, setAttachments] = React.useState<Attachment[]>([])
  const [sending, setSending] = React.useState(false)
  const [reading, setReading] = React.useState(0)
  const [dragging, setDragging] = React.useState(false)
  // Typing on a phone: the keyboard covers the home indicator, so the strip
  // kept clear for it (`safe-area-inset-bottom`, ~34pt) is only a gap between
  // the composer and the keys. A hardware keyboard (an iPad's) leaves the
  // indicator showing, hence the coarse-pointer test.
  const [typing, setTyping] = React.useState(false)
  const area = React.useRef<HTMLTextAreaElement>(null)
  const file = React.useRef<HTMLInputElement>(null)
  const send = useRemote((s) => s.send)
  const interrupt = useRemote((s) => s.interrupt)
  const setError = useRemote((s) => s.setError)
  const queued = useRemote((s) => (chatId ? s.queued[chatId] : undefined)) ?? NO_QUEUE
  const sendQueuedNow = useRemote((s) => s.sendQueuedNow)
  const removeQueued = useRemote((s) => s.removeQueued)

  // Grow with the text, up to a third of the screen.
  React.useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight / 3)}px`
  }, [text])

  // From the attach button, a paste or a drop: each file lands as it is
  // read, so one that fails says why without taking the others with it.
  const addFiles = (files: File[]): void => {
    for (const f of files) {
      setReading((n) => n + 1)
      fileAttachment(f)
        .then((a) => setAttachments((prev) => [...prev, a]))
        .catch((err) =>
          setError(`Couldn't attach ${f.name || 'that file'}${err instanceof Error && err.message ? `: ${err.message}` : '.'}`)
        )
        .finally(() => setReading((n) => n - 1))
    }
  }

  const empty = !text.trim() && attachments.length === 0
  const submit = async (): Promise<void> => {
    if (empty || sending || reading) return
    setSending(true)
    // Sent from a phone, the keyboard goes: the reply is what comes next, and
    // it needs the screen. Dropped on the tap, before the round trip, so it
    // goes the moment the message does.
    if (window.matchMedia('(pointer: coarse)').matches) area.current?.blur()
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
    <div className={cn('shrink-0 px-3 pt-1', typing ? 'pb-2' : 'pb-[max(env(safe-area-inset-bottom),10px)]')}>
      {chatId && queued.length > 0 && (
        <div className="mb-1.5 space-y-1.5">
          {queued.map((q) => (
            <div
              key={q.id}
              className="flex items-center gap-2 rounded-2xl border border-border bg-secondary/40 py-1 pr-1 pl-3 text-[14px] text-muted-foreground"
            >
              <Clock className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{q.text || q.attachments?.map((a) => a.name).join(', ')}</span>
              <button
                type="button"
                aria-label="Send now"
                className="flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] text-foreground active:bg-accent"
                onClick={() => void sendQueuedNow(chatId, q.id)}
              >
                <ArrowUp className="size-3.5" />
                Send now
              </button>
              <button
                type="button"
                aria-label="Remove queued message"
                className="flex size-8 shrink-0 items-center justify-center rounded-full active:bg-accent"
                onClick={() => removeQueued(chatId, q.id)}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {above}
      <div
        className={cn(
          'rounded-[22px] border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_16px_rgb(0_0_0/0.06)] transition-colors dark:shadow-none',
          dragging ? 'border-primary' : 'border-border'
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          const files = filesOf(e.dataTransfer)
          setDragging(false)
          if (!files.length) return
          e.preventDefault()
          addFiles(files)
        }}
      >
        {(attachments.length > 0 || reading > 0) && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {attachments.map((a) => (
              <div key={a.id} className="relative size-16 shrink-0">
                {a.kind === 'image' ? (
                  <img
                    src={`data:${a.mediaType};base64,${a.data}`}
                    alt={a.name}
                    className="size-16 rounded-xl border border-border object-cover"
                  />
                ) : (
                  <div className="flex size-16 flex-col items-center justify-center gap-1 rounded-xl border border-border bg-muted px-1.5">
                    <FileText className="size-5 shrink-0 text-muted-foreground" />
                    <span className="w-full truncate text-center text-[10.5px] leading-tight text-muted-foreground">
                      {a.name}
                    </span>
                  </div>
                )}
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
            {Array.from({ length: reading }, (_, i) => (
              <div key={`reading-${i}`} className="size-16 shrink-0 animate-pulse rounded-xl border border-border bg-muted" />
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
          onFocus={() => setTyping(window.matchMedia('(pointer: coarse)').matches)}
          onBlur={() => setTyping(false)}
          onPaste={(e) => {
            // Text pastes as text; only a paste carrying files is taken over.
            const files = filesOf(e.clipboardData)
            if (!files.length) return
            e.preventDefault()
            addFiles(files)
          }}
          className="block max-h-[33dvh] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[16px] leading-[1.45] outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <button
            type="button"
            aria-label="Attach a photo or file"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
            onClick={() => file.current?.click()}
          >
            <Paperclip className="size-[17px]" />
          </button>
          <input
            ref={file}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              addFiles(files)
            }}
          />
          {tools ?? <div className="flex-1" />}
          {context && context.used > 0 && <ContextRing {...context} />}
          {stop ? (
            <button
              type="button"
              aria-label="Stop"
              onMouseDown={keepKeyboard}
              className="flex size-8 shrink-0 animate-in items-center justify-center rounded-full bg-foreground text-background duration-200 zoom-in-75 fade-in active:scale-90"
              onClick={() => void interrupt(chatId)}
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              onMouseDown={keepKeyboard}
              disabled={sending || empty || reading > 0}
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-200 ease-out',
                empty ? 'scale-90 bg-muted text-muted-foreground' : 'scale-100 bg-foreground text-background active:scale-90'
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

/**
 * The desktop composer's context ring, at a thumb's size. A tap opens the same
 * breakdown the desktop's popover shows (`ContextDetail`), in a sheet.
 */
function ContextRing({
  used,
  window: win,
  provider,
  chatId
}: {
  used: number
  window: number
  provider: Provider
  chatId: string
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const pct = Math.min(1, used / win)
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <>
      <button
        type="button"
        aria-label="Context window usage"
        onClick={() => setOpen(true)}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1 rounded-full px-1.5 active:bg-accent',
          pct > 0.9 ? 'text-destructive' : pct > 0.7 ? 'text-amber-500' : 'text-muted-foreground'
        )}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-border" />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={`${c * pct} ${c}`}
          />
        </svg>
        <span className="text-[12px] tabular-nums">{Math.round(pct * 100)}%</span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)}>
        <div className="px-5 pt-2 pb-4">
          <ContextDetail used={used} window={win} name={PROVIDER_SHORT_LABELS[provider]} chatId={chatId} />
        </div>
      </Sheet>
    </>
  )
}
