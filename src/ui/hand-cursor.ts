import './hand-cursor.css'
import type { CameraHand } from './hand-control'

/** The palm estimate uses the phone camera's nominal 60° horizontal field of view and 4:3 capture. */
export function handCursorPoint(hand: CameraHand) {
  const depth = Math.max(.15, -hand.p[2]), focal = 1 / (2 * Math.tan(Math.PI / 6))
  const inset = (n: number) => Math.max(0, Math.min(1, (n - .12) / .76))
  return { x: inset(.5 + hand.p[0] * focal / depth), y: inset(.5 - hand.p[1] * focal * 4 / 3 / depth) }
}

/** Shared screen feedback. Loss holds the last position briefly; point freezes it until released. */
export class HandCursor {
  private last = -Infinity
  private x = .5
  private y = .5
  constructor(readonly el: HTMLElement) {}
  step(hand: CameraHand | null, now = performance.now()) {
    if (hand?.tracked) {
      this.last = now
      if (!(hand.gestures & 4)) ({ x: this.x, y: this.y } = handCursorPoint(hand))
      this.el.dataset.cameraCursor = hand.gestures & 2 ? 'grip' : hand.gestures & 1 ? 'pinch' : 'hover'
    } else if (now - this.last < 1500) this.el.dataset.cameraCursor = 'lost'
    else { if (this.el.dataset.cameraCursor) { delete this.el.dataset.cameraCursor; this.el.hidden = true }; return null }
    this.el.hidden = false
    this.el.style.transform = `translate(${this.x * innerWidth}px, ${this.y * innerHeight}px)`
    return { x: this.x * innerWidth, y: this.y * innerHeight }
  }
}
