import * as React from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A bottom sheet: the phone's popover. Every picker the desktop draws as a
 * menu under a chip opens one of these instead — a thumb-reachable list with
 * room for each row's description, which a menu on a 390px screen has not.
 *
 * It leaves the way it came: `open` going false plays the exit before the
 * sheet unmounts, so a pick reads as the sheet settling rather than vanishing.
 */
export function Sheet({
  open,
  onClose,
  title,
  children
}: {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element | null {
  const [mounted, setMounted] = React.useState(open)
  const [leaving, setLeaving] = React.useState(false)
  React.useEffect(() => {
    if (open) {
      setMounted(true)
      setLeaving(false)
      return
    }
    if (!mounted) return
    setLeaving(true)
    const t = setTimeout(() => {
      setMounted(false)
      setLeaving(false)
    }, 220)
    return () => clearTimeout(t)
  }, [open, mounted])

  if (!mounted) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close"
        className={cn(
          'absolute inset-0 bg-black/45 backdrop-blur-[2px] transition-opacity duration-200',
          leaving ? 'opacity-0' : 'animate-in fade-in duration-200'
        )}
        onClick={onClose}
      />
      <div
        role="dialog"
        className={cn(
          'relative flex max-h-[82dvh] flex-col rounded-t-[22px] border-t border-border bg-popover text-popover-foreground shadow-2xl',
          'pb-[max(env(safe-area-inset-bottom),12px)]',
          leaving
            ? 'animate-out fade-out slide-out-to-bottom-8 fill-mode-forwards duration-200'
            : 'animate-in fade-in slide-in-from-bottom-10 duration-300 ease-out'
        )}
      >
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30" />
        {title && <div className="shrink-0 px-5 pt-3 pb-1 text-[13px] font-medium text-muted-foreground">{title}</div>}
        <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-1">{children}</div>
      </div>
    </div>,
    document.body
  )
}

export function SheetSection({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="pt-2">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
        {icon}
        {label}
      </div>
      {children}
    </div>
  )
}

export function SheetRow({
  selected,
  icon,
  label,
  description,
  trailing,
  onClick
}: {
  selected?: boolean
  icon?: React.ReactNode
  label: React.ReactNode
  description?: React.ReactNode
  trailing?: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left active:bg-accent',
        selected && 'bg-accent/70'
      )}
    >
      {icon && <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-tight">{label}</span>
        {description && (
          <span className="mt-0.5 block truncate text-[13px] leading-tight text-muted-foreground">{description}</span>
        )}
      </span>
      {trailing}
      <Check className={cn('size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
    </button>
  )
}
