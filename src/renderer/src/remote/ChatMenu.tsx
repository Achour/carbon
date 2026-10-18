import * as React from 'react'
import { Archive, Ellipsis, Pencil, Pin, PinOff } from 'lucide-react'
import type { ChatMeta } from '@shared/types'
import { navigate } from './App'
import { chatTitle } from './format'
import { rename, setArchived, setPinned } from './chatActions'
import { Sheet, SheetRow } from './Sheet'

/**
 * The chat's own menu, from the header's "⋯": rename, pin and archive — what
 * the desktop's row menu does short of deleting, which stays on the Mac. The
 * title keeps its tap, scrolling to the top.
 */
export function ChatMenu({ chat }: { chat: ChatMeta }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [renaming, setRenaming] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const close = (): void => {
    setOpen(false)
    setRenaming(false)
  }
  const pinned = chat.pinnedAt !== undefined
  return (
    <>
      <button
        type="button"
        aria-label="Chat options"
        onClick={() => setOpen(true)}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
      >
        <Ellipsis className="size-[20px]" />
      </button>
      <Sheet open={open} onClose={close} title={renaming ? 'Rename chat' : chatTitle(chat)}>
        {renaming ? (
          <form
            className="flex flex-col gap-3 px-3 pt-1 pb-3"
            onSubmit={(e) => {
              e.preventDefault()
              rename(chat.id, draft)
              close()
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              enterKeyHint="done"
              className="h-11 w-full rounded-xl border border-border bg-card px-3 text-[16px] outline-none focus:border-primary/60"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenaming(false)}
                className="h-10 rounded-xl px-3.5 text-[15px] text-muted-foreground active:bg-accent"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!draft.trim()}
                className="h-10 rounded-xl bg-primary px-4 text-[15px] font-medium text-primary-foreground active:opacity-80 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </form>
        ) : (
          <div className="pb-2">
            <SheetRow
              icon={<Pencil className="size-[18px]" />}
              label="Rename"
              onClick={() => {
                setDraft(chatTitle(chat))
                setRenaming(true)
              }}
            />
            <SheetRow
              icon={pinned ? <PinOff className="size-[18px]" /> : <Pin className="size-[18px]" />}
              label={pinned ? 'Unpin' : 'Pin'}
              onClick={() => {
                setPinned(chat.id, !pinned)
                close()
              }}
            />
            <SheetRow
              icon={<Archive className="size-[18px]" />}
              label="Archive"
              description="Restore it from Settings → Archive on the Mac"
              onClick={() => {
                setArchived(chat.id, true)
                close()
                navigate('#/')
              }}
            />
          </div>
        )}
      </Sheet>
    </>
  )
}
