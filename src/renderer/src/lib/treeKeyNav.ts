import type * as React from 'react'

/**
 * Roving keyboard navigation for a tree, VS Code / Cursor-style. Rows opt in with
 * `data-tree-row` (plus `data-kind="dir|file"` and `data-expanded` on folders);
 * DOM order is the visual order. Focus lives on the actual row `<button>`, so
 * Enter/Space fall through to the button's own click handler — this only wires up
 * the arrow keys.
 */
export function handleTreeKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')
    return

  const container = e.currentTarget
  const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-tree-row]'))
  if (rows.length === 0) return

  const active = document.activeElement as HTMLElement | null
  const idx = active ? rows.indexOf(active) : -1
  const focus = (n: number): void => {
    e.preventDefault()
    rows[Math.max(0, Math.min(n, rows.length - 1))]?.focus()
  }

  if (e.key === 'ArrowDown') return focus(idx < 0 ? 0 : idx + 1)
  if (e.key === 'ArrowUp') return focus(idx <= 0 ? 0 : idx - 1)

  if (idx < 0) return focus(0)
  const row = rows[idx]
  const isDir = row.dataset.kind === 'dir'
  const expanded = row.dataset.expanded === 'true'

  if (e.key === 'ArrowRight') {
    // Expand a collapsed folder; otherwise step into it / down.
    if (isDir && !expanded) {
      e.preventDefault()
      row.click()
    } else {
      focus(idx + 1)
    }
  } else {
    // ArrowLeft: collapse an open folder; otherwise step up toward the parent.
    if (isDir && expanded) {
      e.preventDefault()
      row.click()
    } else {
      focus(idx - 1)
    }
  }
}
