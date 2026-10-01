import './journey.css'
import { mountConstellation } from './constellation'

const space = mountConstellation()
const status = document.querySelector<HTMLElement>('#demo-state')!
let frame = 0, x = 0, y = 0, last = 0, seen = false
function poll(now: number) {
  frame = 0
  if (document.hidden) return
  const dt = Math.min(0.05, (now - (last || now)) / 1000)
  last = now
  const pad = Array.from(navigator.getGamepads?.() ?? []).find(p => p?.connected)
  if (pad) {
    if (!seen) { status.textContent = 'Controller detected. Move the left stick; release it to stop.'; seen = true }
    const axis = (i: number) => Math.abs(pad.axes[i] ?? 0) > 0.12 ? pad.axes[i] : 0
    x = Math.max(-1, Math.min(1, x + axis(0) * dt)); y = Math.max(-1, Math.min(1, y + axis(1) * dt))
    if (axis(0) || axis(1)) { space?.pointer(x, y); document.querySelector('canvas')!.dataset.padInput = 'true' }
  } else if (seen) { status.textContent = 'Controller disconnected. Reopen Link to pair and enable this tab.'; seen = false }
  frame = requestAnimationFrame(poll)
}
document.querySelector('#demo-reset')!.addEventListener('click', () => { x = y = 0; space?.pointer(0, 0) })
document.addEventListener('visibilitychange', () => { cancelAnimationFrame(frame); last = 0; if (!document.hidden) frame = requestAnimationFrame(poll) })
window.addEventListener('pagehide', () => cancelAnimationFrame(frame), { once: true })
frame = requestAnimationFrame(poll)
