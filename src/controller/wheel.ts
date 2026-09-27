/**
 * A scroll wheel under the thumb: the mouse face's wheel and the trackpad's scroll strip. A finger turning it scrolls
 * line by line, with a tick felt for each notch; turned fast it spins free, with no notches, and carries on after the
 * finger lifts, slowing, the way a speed-adaptive mouse wheel does. A touch stops a spin. Its ridges move with it
 * (the element's --turn). Optionally a tap and a hold mean something too (the mouse face: middle click, autoscroll).
 */
import { toUi } from './uiframe'

export interface WheelDeps {
  /** Wheel units turned (120 a notch, + scrolls down), batched every SEND_MS. */
  turn(units: number): void
  /** A notch passed under the thumb. */
  notch(): void
  /** A tap without turning it. */
  tap?(): void
  /** Held still (true), then let go (false). */
  hold?(down: boolean): void
}

/** Moving this far (px) turns it; staying still this long (ms) holds it. */
const TURN_SLOP = 6
const HOLD_MS = 260
/** Wheel units per px of thumb (a notch, 120, is about 16 px). */
const UNITS_PER_PX = 7.5
const NOTCH = 120
/** Turned faster than this (px/ms) it spins free; a spin fades with this time constant (ms) and stops below this. */
const FREE_SPIN = 0.9
const SPIN_TAU = 420
const SPIN_STOP = 0.03
/** How often a turning wheel is sent (ms). */
const SEND_MS = 24

type Touch = { id: number; y: number; t: number; moved: number; mode: 'wait' | 'turn' | 'hold'; timer: number; v: number }

export class ScrollWheel {
  private f: Touch | null = null
  private pending = 0
  private sendTimer = 0
  private notches = 0
  private turned = 0
  private spin: { v: number; at: number } | null = null
  private raf = 0

  constructor(private readonly el: HTMLElement, private readonly deps: WheelDeps) {
    el.addEventListener('pointerdown', this.down)
    el.addEventListener('pointermove', this.move)
    el.addEventListener('pointerup', this.up)
    el.addEventListener('pointercancel', this.up)
    el.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  /** Stop and let go of everything (hidden, or the screen went away). */
  reset() {
    const f = this.f
    if (f) { clearTimeout(f.timer); if (f.mode === 'hold') this.deps.hold?.(false) }
    this.f = null
    this.el.classList.remove('turning')
    this.stopSpin()
  }

  private down = (e: PointerEvent) => {
    // The wheel's own gesture: not the trackpad's, nor the page's.
    e.preventDefault()
    e.stopPropagation()
    if (this.f) return
    try { this.el.setPointerCapture(e.pointerId) } catch { /* not a live pointer */ }
    // A touch stops a free spin, the way a finger stops a real wheel.
    this.stopSpin()
    const f: Touch = { id: e.pointerId, y: toUi(e.clientX, e.clientY).y, t: e.timeStamp, moved: 0, mode: 'wait', v: 0, timer: 0 }
    if (this.deps.hold) f.timer = window.setTimeout(() => { if (this.f === f && f.mode === 'wait') { f.mode = 'hold'; this.deps.hold!(true) } }, HOLD_MS)
    this.f = f
  }

  private move = (e: PointerEvent) => {
    const f = this.f
    if (!f || e.pointerId !== f.id) return
    const y = toUi(e.clientX, e.clientY).y
    const dy = y - f.y
    const dt = Math.max(1, e.timeStamp - f.t)
    f.y = y
    f.t = e.timeStamp
    f.moved += Math.abs(dy)
    f.v = f.v * 0.6 + (dy / dt) * 0.4
    if (f.mode === 'wait' && f.moved > TURN_SLOP) { f.mode = 'turn'; clearTimeout(f.timer); this.el.classList.add('turning') }
    if (f.mode === 'turn') this.turn(dy, Math.abs(f.v) > FREE_SPIN)
  }

  private up = (e: PointerEvent) => {
    const f = this.f
    if (!f || e.pointerId !== f.id) return
    clearTimeout(f.timer)
    this.f = null
    this.el.classList.remove('turning')
    if (f.mode === 'wait') this.deps.tap?.()
    else if (f.mode === 'hold') this.deps.hold?.(false)
    else if (Math.abs(f.v) > FREE_SPIN && e.type === 'pointerup') this.startSpin(f.v)
    else this.flush()
  }

  /** Turned by `px` of thumb (+ is toward the hand: scroll down). */
  private turn(px: number, free: boolean) {
    const units = px * UNITS_PER_PX
    this.pending += units
    this.turned += px
    this.el.style.setProperty('--turn', `${this.turned.toFixed(1)}px`)
    if (free) this.notches = 0
    else {
      this.notches += units
      while (Math.abs(this.notches) >= NOTCH) { this.notches -= Math.sign(this.notches) * NOTCH; this.deps.notch() }
    }
    if (!this.sendTimer) this.sendTimer = window.setTimeout(() => this.flush(), SEND_MS)
  }

  private flush() {
    clearTimeout(this.sendTimer)
    this.sendTimer = 0
    const v = Math.trunc(this.pending)
    if (!v) return
    this.pending -= v
    this.deps.turn(v)
  }

  private startSpin(v: number) {
    this.spin = { v, at: performance.now() }
    this.el.classList.add('spinning')
    const step = (now: number) => {
      const s = this.spin
      if (!s) return
      const dt = Math.min(50, now - s.at)
      s.at = now
      s.v *= Math.exp(-dt / SPIN_TAU)
      this.turn(s.v * dt, true)
      if (Math.abs(s.v) < SPIN_STOP) { this.stopSpin(); return }
      this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  private stopSpin() {
    cancelAnimationFrame(this.raf)
    this.spin = null
    this.el.classList.remove('spinning')
    this.flush()
  }
}
