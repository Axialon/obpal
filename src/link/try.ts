import './journey.css'
import { mountConstellation } from './constellation'

const space = mountConstellation()
const status = document.querySelector<HTMLElement>('#demo-state')!
const guidance = document.querySelector<HTMLElement>('#demo-guidance')!
const canvas = document.querySelector<HTMLCanvasElement>('#link-space')!
const motion = matchMedia('(prefers-reduced-motion: reduce)')
let frame = 0, x = 0, y = 0, last = 0, seen = false, active = false, released = false, disconnected = false, away = false

function feedback() {
  const mode = motion.matches ? 'reduced' : canvas.hidden ? 'unavailable' : 'motion'
  status.dataset.feedbackMode = mode
  const guide = mode === 'reduced' ? 'The constellation stays still with reduced motion. Left-stick input appears below.'
    : mode === 'unavailable' ? 'Constellation motion is unavailable. Left-stick input appears below.'
    : 'Your left stick turns the constellation. Let go to stop. Input also appears below.'
  if (guidance.textContent !== guide) guidance.textContent = guide
  const text = away || document.hidden ? 'Controller input paused while this page is hidden.'
    : disconnected ? 'Controller disconnected. Reopen Link to pair and enable this tab.'
    : !seen ? 'Open Link, pair a phone, choose Controller and enable This tab.'
    : active ? 'Controller detected. Left stick input detected. Release it to return to neutral.'
    : released ? 'Controller detected. Left stick released. Input is neutral.'
    : 'Controller detected. Left stick is neutral. Move it to try input.'
  if (status.textContent !== text) status.textContent = text
}

function poll(now: number) {
  frame = 0
  if (away || document.hidden) return
  const dt = Math.min(0.05, Math.max(0, (now - (last || now)) / 1000))
  last = now
  const pad = Array.from(navigator.getGamepads?.() ?? []).find(p => p?.connected)
  if (pad) {
    seen = true; disconnected = false
    const axis = (i: number) => {
      const value = pad.axes[i] ?? 0
      return Number.isFinite(value) && Math.abs(value) > 0.12 ? Math.max(-1, Math.min(1, value)) : 0
    }
    const dx = axis(0), dy = axis(1)
    if (active && !dx && !dy) released = true
    active = !!(dx || dy)
    if (active && !motion.matches && !canvas.hidden) {
      x = Math.max(-1, Math.min(1, x + dx * dt)); y = Math.max(-1, Math.min(1, y + dy * dt))
      space.pointer(x, y)
    }
  } else {
    if (seen) disconnected = true
    seen = active = released = false
  }
  canvas.dataset.padInput = String(active)
  feedback()
  frame = requestAnimationFrame(poll)
}

function stop() {
  cancelAnimationFrame(frame); frame = 0; last = 0
  canvas.dataset.padInput = 'false'
  feedback()
}
function start() {
  cancelAnimationFrame(frame); frame = 0; last = 0
  if (away || document.hidden) feedback()
  else poll(performance.now())
}
document.querySelector('#demo-reset')!.addEventListener('click', () => {
  x = y = 0
  if (!motion.matches && !canvas.hidden) space.pointer(0, 0)
  if (!away && !document.hidden) start()
})
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (!away) start() })
window.addEventListener('pagehide', () => { away = true; stop() })
window.addEventListener('pageshow', () => { away = false; if (!document.hidden) start() })
start()
