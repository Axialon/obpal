/**
 * 3D viewer mode: turn phone input into the mouse gestures every web 3D viewer already understands.
 * Rotate = left-button drag, pan = right-button (or shift) drag, zoom = wheel.
 * Pure: viewerMotion() is the input math, DragSynth the gesture state machine; the page script dispatches.
 */
import { PadButton } from '@obpal/core'
import { Accum, buttonValue, clamp, stickCurve, type PadInput } from './math'

/**
 * Gains are signed: positive moves the content with the input, as if dragging it; negative inverts.
 * Rates (px/s) apply to sticks, tilt and triggers; gains apply to per-frame deltas.
 */
export interface ViewerConfig {
  /** Screen px of rotate-drag per px of phone trackpad travel. */
  padGain: number
  /** Screen px of rotate-drag per degree of phone aim (Point mode gyro). */
  aimGain: number
  /** Rotate-drag speed at full right-stick deflection, px/s. */
  stickSpeed: number
  /** Rotate-drag speed at full tilt (Tilt mode), px/s. */
  tiltSpeed: number
  /** Screen px of pan per px of two-finger phone travel. */
  panGain: number
  /** Pan speed at full left-stick deflection, px/s. */
  panStickSpeed: number
  /** Wheel deltaY per log2 unit of pinch (pinching out zooms in, i.e. negative deltaY). */
  wheelPerZoom: number
  /** Wheel px/s at full trigger: RT zooms in, LT zooms out. */
  triggerWheel: number
  /** Smallest |deltaY| sent as its own wheel event; smaller amounts accumulate. */
  wheelStep: number
  deadzone: number
  tiltDeadzone: number
  triggerDeadzone: number
  /** Stick response exponent (1 = linear). */
  expo: number
  /** Release the synthetic button after this long without drag input, ms. */
  releaseMs: number
  /** Pan with a right-button drag (most viewers) or a shift + left drag. */
  pan: 'right' | 'shift'
}

export const DEFAULT_VIEWER: ViewerConfig = {
  padGain: 1.6, aimGain: 12, stickSpeed: 900, tiltSpeed: 700, panGain: 1.4, panStickSpeed: 700,
  wheelPerZoom: 480, triggerWheel: 1400, wheelStep: 8,
  deadzone: 0.15, tiltDeadzone: 0.04, triggerDeadzone: 0.05, expo: 1.5,
  releaseMs: 120, pan: 'right',
}

export interface Deltas {
  /** Phone aim since the last frame, degrees: [yaw + left, pitch + up]. */
  aim: readonly [number, number]
  /** One-finger trackpad travel, px. */
  pad1: readonly [number, number]
  /** Two-finger pan travel, px. */
  pad2: readonly [number, number]
  /** Pinch, log2(scale) since the last frame. */
  zoom: number
}

export interface ViewerInput {
  pad: PadInput | null
  deltas: Deltas | null
  tilt: readonly [number, number] | null
  dtMs: number
}

/** Screen-space motion for one frame: rotate-drag and pan px, and wheel deltaY (negative = zoom in). */
export interface ViewerMotion {
  drag: [number, number]
  pan: [number, number]
  wheel: number
}

export function viewerMotion(input: ViewerInput, cfg: ViewerConfig = DEFAULT_VIEWER): ViewerMotion {
  const dt = clamp(input.dtMs, 0, 100) / 1000
  const drag: [number, number] = [0, 0]
  const pan: [number, number] = [0, 0]
  let wheel = 0
  const d = input.deltas
  if (d) {
    // Aim is + left / + up, and screen y grows downward, so both aim axes are negated.
    drag[0] += d.pad1[0] * cfg.padGain - d.aim[0] * cfg.aimGain
    drag[1] += d.pad1[1] * cfg.padGain - d.aim[1] * cfg.aimGain
    pan[0] += d.pad2[0] * cfg.panGain
    pan[1] += d.pad2[1] * cfg.panGain
    wheel -= d.zoom * cfg.wheelPerZoom
  }
  const p = input.pad
  if (p) {
    drag[0] += stickCurve(p.axes[2], cfg.deadzone, cfg.expo) * cfg.stickSpeed * dt
    drag[1] += stickCurve(p.axes[3], cfg.deadzone, cfg.expo) * cfg.stickSpeed * dt
    pan[0] += stickCurve(p.axes[0], cfg.deadzone, cfg.expo) * cfg.panStickSpeed * dt
    pan[1] += stickCurve(p.axes[1], cfg.deadzone, cfg.expo) * cfg.panStickSpeed * dt
    const zoomIn = stickCurve(buttonValue(p, PadButton.RT), cfg.triggerDeadzone)
    const zoomOut = stickCurve(buttonValue(p, PadButton.LT), cfg.triggerDeadzone)
    wheel += (zoomOut - zoomIn) * cfg.triggerWheel * dt
  }
  const t = input.tilt
  if (t) {
    drag[0] += stickCurve(t[0], cfg.tiltDeadzone) * cfg.tiltSpeed * dt
    drag[1] += stickCurve(t[1], cfg.tiltDeadzone) * cfg.tiltSpeed * dt
  }
  return { drag, pan, wheel }
}

export interface Rect { left: number; top: number; width: number; height: number }

/** One synthetic mouse/pointer step. Coordinates are client px; button/buttons follow MouseEvent semantics. */
export type SynthEvent =
  | { type: 'down'; button: 0 | 2; buttons: number; x: number; y: number; shift: boolean }
  | { type: 'move'; buttons: number; x: number; y: number; dx: number; dy: number; shift: boolean }
  | { type: 'up'; button: 0 | 2; x: number; y: number; shift: boolean }
  | { type: 'wheel'; x: number; y: number; deltaY: number }

type Kind = 'rotate' | 'pan'
interface Gesture { kind: Kind; x: number; y: number; area: Rect; last: number }

const EDGE = 6
const centre = (a: Rect) => ({ x: Math.round(a.left + a.width / 2), y: Math.round(a.top + a.height / 2) })
const mag = (v: readonly [number, number]) => Math.hypot(v[0], v[1])
function inside(a: Rect, x: number, y: number) {
  const m = Math.min(EDGE, a.width / 4, a.height / 4)
  return x >= a.left + m && x <= a.left + a.width - m && y >= a.top + m && y <= a.top + a.height - m
}

/**
 * Gesture state machine: button down at the target's centre on the first motion, moves while input keeps
 * coming, button up after `releaseMs` idle. Moves are whole pixels (sub-pixel motion accumulates). When the
 * virtual cursor reaches the target's edge it lifts and re-grabs at the centre, like a hand on a mouse pad.
 */
export class DragSynth {
  private g: Gesture | null = null
  private acc = new Accum()
  private wheelAcc = 0
  private wheelAt = 0
  private lastArea: Rect = { left: 0, top: 0, width: 0, height: 0 }

  constructor(public cfg: ViewerConfig = DEFAULT_VIEWER) {}

  /** A button is held. */
  get dragging() { return this.g !== null }
  /** Something is pending that tick() will finish (a held button or unsent wheel). */
  get busy() { return this.g !== null || this.wheelAcc !== 0 }

  /** Feed one frame of motion at `now` (ms). New gestures start at the centre of `area` (the target's visible box). */
  step(now: number, m: ViewerMotion, area: Rect): SynthEvent[] {
    const out: SynthEvent[] = []
    this.lastArea = area
    const hasDrag = m.drag[0] !== 0 || m.drag[1] !== 0
    const hasPan = m.pan[0] !== 0 || m.pan[1] !== 0
    let kind: Kind | null = null
    // Stay in the current gesture while it has input; otherwise pick the stronger of rotate and pan.
    if (this.g && (this.g.kind === 'rotate' ? hasDrag : hasPan)) kind = this.g.kind
    else if (hasDrag || hasPan) kind = hasDrag && (!hasPan || mag(m.drag) >= mag(m.pan)) ? 'rotate' : 'pan'

    if (kind) {
      let g = this.g
      if (g && g.kind !== kind) {
        out.push(...this.release())
        g = null
      }
      if (!g) g = this.press(kind, area, now, out)
      g.last = now
      const v = kind === 'rotate' ? m.drag : m.pan
      const [ix, iy] = this.acc.take(v[0], v[1])
      if (ix || iy) {
        if (!inside(g.area, g.x + ix, g.y + iy)) {
          const a = g.area
          out.push(...this.release())
          g = this.press(kind, a, now, out)
        }
        g.x += ix
        g.y += iy
        out.push({ type: 'move', buttons: this.buttonsOf(kind), x: g.x, y: g.y, dx: ix, dy: iy, shift: this.shiftOf(kind) })
      }
    }

    if (m.wheel) {
      this.wheelAcc += m.wheel
      this.wheelAt = now
      if (Math.abs(this.wheelAcc) >= this.cfg.wheelStep) out.push(this.flushWheel())
    }
    return out
  }

  /** Call between frames: lifts the button after releaseMs without drag input and flushes a leftover wheel amount. */
  tick(now: number): SynthEvent[] {
    const out: SynthEvent[] = []
    if (this.g && now - this.g.last >= this.cfg.releaseMs) out.push(...this.release())
    if (this.wheelAcc !== 0 && now - this.wheelAt >= this.cfg.releaseMs) {
      if (Math.abs(this.wheelAcc) >= 0.5) out.push(this.flushWheel())
      this.wheelAcc = 0
    }
    return out
  }

  /** Lift the button now (gesture switch, mode change, deactivation). */
  release(): SynthEvent[] {
    const g = this.g
    if (!g) return []
    this.g = null
    this.acc.reset()
    return [{ type: 'up', button: this.buttonOf(g.kind), x: g.x, y: g.y, shift: this.shiftOf(g.kind) }]
  }

  /** release() and drop any unsent wheel. */
  reset(): SynthEvent[] {
    this.wheelAcc = 0
    return this.release()
  }

  /** Start a gesture at the centre of `area`: records it and appends the button-down event. */
  private press(kind: Kind, area: Rect, now: number, out: SynthEvent[]): Gesture {
    const c = centre(area)
    const g: Gesture = { kind, x: c.x, y: c.y, area, last: now }
    this.g = g
    out.push({ type: 'down', button: this.buttonOf(kind), buttons: this.buttonsOf(kind), x: c.x, y: c.y, shift: this.shiftOf(kind) })
    return g
  }

  private flushWheel(): SynthEvent {
    const p = this.g ?? centre(this.lastArea)
    const deltaY = Math.round(this.wheelAcc)
    this.wheelAcc -= deltaY
    return { type: 'wheel', x: p.x, y: p.y, deltaY }
  }

  private buttonOf(kind: Kind): 0 | 2 { return kind === 'pan' && this.cfg.pan === 'right' ? 2 : 0 }
  private buttonsOf(kind: Kind) { return this.buttonOf(kind) === 2 ? 2 : 1 }
  private shiftOf(kind: Kind) { return kind === 'pan' && this.cfg.pan === 'shift' }
}
