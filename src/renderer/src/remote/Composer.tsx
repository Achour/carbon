import * as React from 'react'
import { ArrowUp, Clock, CornerDownRight, FileText, Paperclip, Square, X } from 'lucide-react'
import type { Attachment, SlashCommand } from '@shared/types'
import { PROVIDER_SHORT_LABELS, type Provider } from '@shared/types'
import { CODEX_SLASH_COMMANDS } from '@shared/codexCommands'
import { withBtw } from '@shared/btw'
import { FileIcon } from '@/lib/fileIcon'
import { randomId } from '@/lib/insecureContext'
import { cn } from '@/lib/utils'
import { ContextDetail } from '@/components/ContextDetail'
import { useRemote, type QueuedMessage } from './state'
import { Sheet } from './Sheet'
import { clearDraft, patchDraft, readDraft } from './drafts'
import * as api from './api'
import { isNative, useNativeComposer } from './native'

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
 * Each project's `/` commands, per provider, for the life of the page: the
 * Mac reads them off disk (skills, `.claude/commands`), and a list that moves
 * only when someone adds a skill is not worth a round trip per keystroke.
 */
const commandCache = new Map<string, Promise<SlashCommand[]>>()
function commandsFor(cwd: string, provider: Provider): Promise<SlashCommand[]> {
  // Codex's are fixed and Carbon's own (`CODEX_SLASH_COMMANDS`), as the
  // desktop composer uses them rather than a shared cache.
  if (provider === 'codex') return Promise.resolve(CODEX_SLASH_COMMANDS)
  const key = `${provider}\0${cwd}`
  let hit = commandCache.get(key)
  if (!hit) {
    hit = api.invoke<SlashCommand[]>('commands:get', cwd, provider).catch(() => {
      commandCache.delete(key)
      return []
    })
    commandCache.set(key, hit)
  }
  return hit
}

/** The desktop composer's ranking: name or alias contains, prefix first. */
function rankCommands(list: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase()
  return list
    .filter((c) => c.name.toLowerCase().includes(q) || (c.aliases ?? []).some((a) => a.toLowerCase().includes(q)))
    .sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
      return ap - bp || a.name.localeCompare(b.name)
    })
    .slice(0, 30)
}

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
  cwd,
  provider,
  draftKey,
  onCommand,
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
  /** The project, for `@` file names and the `/` commands; neither opens without it. */
  cwd?: string
  /** Whose `/` commands to offer. */
  provider?: Provider
  /** Where the unsent text is kept (`drafts.ts`). */
  draftKey?: string
  /**
   * A whole message that is a command the screen answers itself — Codex's
   * `/review`, which opens its presets instead of being sent. True takes it.
   */
  onCommand?: (text: string) => boolean
  /** Replaces the default send — the new-chat screen creates the chat first. */
  onSubmit?: (text: string, attachments: Attachment[]) => Promise<void>
}): React.JSX.Element {
  const [text, setText] = React.useState(() => (draftKey ? (readDraft(draftKey)?.text ?? '') : ''))
  const [attachments, setAttachments] = React.useState<Attachment[]>([])
  const [sending, setSending] = React.useState(false)
  const [reading, setReading] = React.useState(0)
  const [dragging, setDragging] = React.useState(false)
  // Typing on a phone: the keyboard covers the home indicator, so the strip
  // kept clear for it (`safe-area-inset-bottom`, ~34pt) is only a gap between
  // the composer and the keys. A hardware keyboard (an iPad's) leaves the
  // indicator showing, hence the coarse-pointer test.
  const [typing, setTyping] = React.useState(false)
  // Counts the text changes the composer makes itself (a pick, a send, a
  // suggestion taken), as opposed to typing: inside the iOS app, the field is
  // the app's, and this is its cue to take the page's text over its own.
  const [pageRev, setPageRev] = React.useState(0)
  const edit = (next: string): void => {
    setText(next)
    setPageRev((n) => n + 1)
  }
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

  // The draft follows the text, a beat behind the keys, and is written once
  // more as the composer goes — leaving mid-sentence is the case it is for.
  const latest = React.useRef(text)
  latest.current = text
  React.useEffect(() => {
    if (!draftKey) return undefined
    const t = setTimeout(() => patchDraft(draftKey, { text }), 300)
    return () => clearTimeout(t)
  }, [draftKey, text])
  React.useEffect(() => {
    if (!draftKey) return undefined
    return () => patchDraft(draftKey, { text: latest.current })
  }, [draftKey])

  // ---- `@` files and `/` commands, as the desktop composer opens them ----
  // `@` after a space or at the start opens the file list; a `/` that is the
  // whole message so far opens the commands, and the first space closes it.
  const [caret, setCaret] = React.useState(0)
  const before = text.slice(0, caret)
  const mentionMatch = cwd ? /(^|\s)@([\w./-]*)$/.exec(before) : null
  const mention = mentionMatch ? { query: mentionMatch[2], at: caret - mentionMatch[2].length } : null
  const slashMatch = cwd && provider ? /^\/([\w:-]*)$/.exec(before) : null
  const slashQuery = slashMatch ? slashMatch[1] : null
  const [dismissed, setDismissed] = React.useState<string | null>(null)
  const menuKey = mention ? `@${mention.at}` : slashQuery !== null ? '/' : null
  const menuOpen = menuKey !== null && menuKey !== dismissed
  // A ✕ closes that one list, not the next: once the text no longer opens
  // one, the dismissal is spent.
  React.useEffect(() => {
    if (menuKey === null) setDismissed(null)
  }, [menuKey])

  const [files, setFiles] = React.useState<{ rel: string; path: string }[]>([])
  const mentionQuery = mention?.query ?? null
  React.useEffect(() => {
    if (mentionQuery === null || !cwd) {
      setFiles([])
      return undefined
    }
    let alive = true
    const t = setTimeout(() => {
      api
        .invoke<{ rel: string; path: string }[]>('fs:search', cwd, mentionQuery)
        .then((res) => alive && setFiles(res))
        .catch(() => alive && setFiles([]))
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [mentionQuery, cwd])

  const [commands, setCommands] = React.useState<SlashCommand[]>([])
  const wantsCommands = slashQuery !== null
  React.useEffect(() => {
    if (!wantsCommands || !cwd || !provider) return undefined
    let alive = true
    // `/btw` only beside a conversation, as on the desktop.
    void commandsFor(cwd, provider).then((list) => alive && setCommands(chatId ? withBtw(list) : list))
    return () => {
      alive = false
    }
  }, [wantsCommands, cwd, provider, chatId])
  const commandRows = slashQuery !== null ? rankCommands(commands, slashQuery) : []

  const putCaret = (pos: number): void => {
    setCaret(pos)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(pos, pos)
    })
  }
  const pickFile = (r: { rel: string; path: string }): void => {
    if (!mention) return
    const head = text.slice(0, mention.at)
    edit(`${head}${r.rel} ${text.slice(caret)}`)
    // Attached by path, as the desktop's mention does, so the agent is handed
    // the file and not only its name in the prose.
    setAttachments((prev) =>
      prev.some((a) => a.path === r.path)
        ? prev
        : [...prev, { id: randomId(), kind: 'file', name: r.rel.split('/').pop() ?? r.rel, path: r.path }]
    )
    putCaret(head.length + r.rel.length + 1)
  }
  const pickCommand = (c: SlashCommand): void => {
    const tail = text.slice(caret)
    const command = `/${c.name}`
    // A command with no argument shape is complete when picked: it runs on
    // the tap, as the desktop's does on Enter.
    if (!c.argumentHint && !tail.trim() && attachments.length === 0) {
      void submit(command)
      return
    }
    edit(`${command} ${tail.replace(/^\s+/, '')}`)
    putCaret(command.length + 1)
  }

  const empty = !text.trim() && attachments.length === 0
  // The provider's own guess at the next message (Claude's and Grok's). A
  // phone has no Tab, so it is a chip above the card: a tap puts it in the
  // input, and sending stays a second tap.
  const suggestion = useRemote((s) => (chatId ? s.suggestions[chatId] : undefined))
  const offer = suggestion && !busy && !sending && empty ? suggestion : undefined
  const submit = async (override?: string): Promise<void> => {
    const message = (override ?? text).trim()
    if ((!message && attachments.length === 0) || sending || reading) return
    if (onCommand && attachments.length === 0 && onCommand(message)) {
      edit('')
      if (draftKey) clearDraft(draftKey)
      return
    }
    setSending(true)
    // Sent from a phone, the keyboard goes: the reply is what comes next, and
    // it needs the screen. Dropped on the tap, before the round trip, so it
    // goes the moment the message does.
    if (window.matchMedia('(pointer: coarse)').matches) area.current?.blur()
    try {
      if (onSubmit) await onSubmit(message, attachments)
      else if (chatId) await send(chatId, message, attachments)
      edit('')
      setAttachments([])
      latest.current = ''
      if (draftKey) clearDraft(draftKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }
  const stop = busy && chatId && empty

  // Inside the iOS app this is the composer's model, not its view: the app
  // draws the field on the keyboard and calls back here for every change, so
  // the queue, the drafts, `@`, `/` and `onCommand` stay this component's.
  const menu =
    menuOpen && mention && files.length > 0
      ? { kind: 'files' as const, rows: files.map((r) => ({ id: r.path, label: r.rel })) }
      : menuOpen && !mention && commandRows.length > 0
        ? {
            kind: 'commands' as const,
            rows: commandRows.map((c) => ({
              id: c.name,
              label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`,
              detail: c.description || undefined
            }))
          }
        : undefined
  useNativeComposer(
    {
      key: draftKey ?? chatId ?? 'composer',
      chatId,
      placeholder: placeholder ?? (busy ? 'Queue a message…' : 'Message…'),
      text,
      textRev: pageRev,
      caret,
      busy: !!busy,
      stop: !!stop,
      sending,
      reading,
      attachments: attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
      queued: queued.map((q) => ({ id: q.id, text: q.text || (q.attachments?.map((a) => a.name).join(', ') ?? '') })),
      suggestion: offer,
      menu
    },
    {
      setText: (next, at) => {
        setText(next)
        setCaret(at)
      },
      submit: () => void submit(),
      stop: () => {
        if (chatId) void interrupt(chatId)
      },
      pick: (id) => {
        if (mention) {
          const r = files.find((f) => f.path === id)
          if (r) pickFile(r)
        } else {
          const c = commandRows.find((row) => row.name === id)
          if (c) pickCommand(c)
        }
      },
      dismissMenu: () => setDismissed(menuKey),
      removeAttachment: (id) => setAttachments((prev) => prev.filter((a) => a.id !== id)),
      addFiles,
      takeSuggestion: () => {
        if (offer) edit(offer)
      }
    }
  )
  if (isNative) {
    // The pickers register themselves from inside `tools` and draw nothing;
    // `above` (a pending switch) stays on the page, just over the app's
    // composer; the project and worktree chips mount there to register.
    return (
      <>
        {above && <div className="shrink-0 px-3">{above}</div>}
        {tools}
      </>
    )
  }

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
      {offer && (
        <button
          type="button"
          onMouseDown={keepKeyboard}
          onClick={() => {
            edit(offer)
            putCaret(offer.length)
          }}
          className="mb-2 flex h-9 max-w-full animate-in items-center gap-2 rounded-xl border border-border bg-card px-3 text-[14px] duration-200 fade-in active:bg-accent"
        >
          <CornerDownRight className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{offer}</span>
        </button>
      )}
      <div className="relative">
      {menuOpen && (mention ? files.length > 0 : commandRows.length > 0) && (
        <div
          role="listbox"
          aria-label={mention ? 'Files' : 'Commands'}
          className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-[min(40dvh,320px)] animate-in overflow-y-auto overscroll-contain rounded-2xl border border-border bg-popover p-1 shadow-lg duration-150 fade-in"
        >
          <div className="flex items-center justify-between px-3 pt-1.5 pb-1 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
            {mention ? 'Files' : 'Commands'}
            <button
              type="button"
              aria-label="Close"
              onMouseDown={keepKeyboard}
              onClick={() => setDismissed(menuKey)}
              className="-mr-1.5 flex size-7 items-center justify-center rounded-full active:bg-accent"
            >
              <X className="size-3.5" />
            </button>
          </div>
          {mention
            ? files.map((r) => {
                const slash = r.rel.lastIndexOf('/')
                return (
                  <button
                    key={r.path}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onMouseDown={keepKeyboard}
                    onClick={() => pickFile(r)}
                    className="flex w-full min-w-0 items-center gap-2.5 rounded-xl px-3 py-2 text-left active:bg-accent"
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <FileIcon path={r.rel} />
                    </span>
                    <span className="shrink-0 text-[15px]">{r.rel.slice(slash + 1)}</span>
                    {slash > 0 && (
                      <span className="min-w-0 truncate text-[13px] text-muted-foreground">
                        {r.rel.slice(0, slash)}
                      </span>
                    )}
                  </button>
                )
              })
            : commandRows.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onMouseDown={keepKeyboard}
                  onClick={() => pickCommand(c)}
                  className="flex w-full min-w-0 flex-col rounded-xl px-3 py-2 text-left active:bg-accent"
                >
                  <span className="text-[15px]">
                    /{c.name}
                    {c.argumentHint && <span className="ml-1.5 text-muted-foreground">{c.argumentHint}</span>}
                  </span>
                  {c.description && (
                    <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted-foreground">{c.description}</span>
                  )}
                </button>
              ))}
        </div>
      )}
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
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart ?? e.target.value.length)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
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
