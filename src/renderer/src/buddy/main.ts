import type { BuddyBridge, BuddyState } from '@shared/types'
import { BEAR_SVG } from './bear'
import './buddy.css'

declare global {
  interface Window {
    buddy: BuddyBridge
  }
}

/** Pointer travel that turns a press into a drag rather than a click. */
const DRAG_THRESHOLD = 4

const stage = document.getElementById('stage')!
const hit = document.getElementById('bear-hit')!
const bubble = document.getElementById('bubble')!
const bubbleText = document.getElementById('bubble-text')!
hit.innerHTML = BEAR_SVG

let state: BuddyState = { mood: 'idle' }

window.buddy.onState((next) => {
  state = next
  stage.dataset.mood = next.mood
  if (next.text) {
    // Re-adding `hidden` and removing it replays the pop-in only when the
    // words changed, not on every state that keeps them.
    if (bubble.hidden || bubbleText.textContent !== next.text) {
      bubble.hidden = true
      void bubble.offsetWidth
      bubbleText.textContent = next.text
      bubble.hidden = false
    }
  } else bubble.hidden = true
})

// The window is click-through except over the bear and its bubble. Main starts
// it ignoring the mouse with events forwarded, so moves still arrive here.
let passing = true
function setPassing(on: boolean): void {
  if (on === passing) return
  passing = on
  window.buddy.passThrough(on)
}
document.addEventListener('pointermove', (e) => {
  if (press) return
  const over = (e.target as Element | null)?.closest?.('#bear-hit .bear, #bubble')
  setPassing(!over)
})
document.addEventListener('pointerleave', () => {
  if (!press) setPassing(true)
})

let press: { id: number; x: number; y: number; dragging: boolean } | null = null

function onDown(e: PointerEvent): void {
  if (e.button !== 0) return
  press = { id: e.pointerId, x: e.screenX, y: e.screenY, dragging: false }
  ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
}

function onMove(e: PointerEvent): void {
  if (!press || e.pointerId !== press.id) return
  const dx = e.screenX - press.x
  const dy = e.screenY - press.y
  if (!press.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
  press.dragging = true
  hit.classList.add('dragging')
  press.x = e.screenX
  press.y = e.screenY
  window.buddy.drag(dx, dy)
}

function onUp(e: PointerEvent): void {
  if (!press || e.pointerId !== press.id) return
  const wasDrag = press.dragging
  press = null
  hit.classList.remove('dragging')
  if (wasDrag) {
    window.buddy.drag(0, 0, true)
    return
  }
  // Nothing to open: the click is a pat, and Carbon just comes forward.
  if (!state.hasChat) pat()
  window.buddy.click()
}

let patTimer: ReturnType<typeof setTimeout> | undefined
function pat(): void {
  stage.classList.remove('petting')
  void stage.offsetWidth
  stage.classList.add('petting')
  clearTimeout(patTimer)
  patTimer = setTimeout(() => stage.classList.remove('petting'), 1500)
}

for (const el of [hit, bubble]) {
  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', () => {
    press = null
    hit.classList.remove('dragging')
  })
}
