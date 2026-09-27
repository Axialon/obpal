/**
 * Small, pure pieces every device shares for reading a phone: sticks with a deadzone, pad buttons by edge, the
 * trackpad as a floating stick, and the 1:1 turn as a dial or a slope.
 */
import { PadButton, qRotate, type PadState, type Quat } from '@obpal/core'

const R2D = 180 / Math.PI
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** One axis past a deadzone, rescaled so it still reaches 1. */
export function axis(v: number, dz = 0.12): number {
  const m = Math.abs(v)
  return m <= dz ? 0 : Math.sign(v) * Math.min(1, (m - dz) / (1 - dz))
}

/** A stick past a radial deadzone: pushed less than `dz` it's centred; the rest rescales, so its direction is exact. */
export function stick(x: number, y: number, dz = 0.12): [number, number] {
  const m = Math.hypot(x, y)
  if (m <= dz) return [0, 0]
  const k = Math.min(1, (m - dz) / (1 - dz)) / m
  return [x * k, y * k]
}

/** The pad's left or right stick, deadzoned ([x + right, y + down], as the Gamepad API has it). */
export const padStick = (pad: PadState, side: 'left' | 'right', dz = 0.12) => (side === 'left' ? stick(pad.axes[0], pad.axes[1], dz) : stick(pad.axes[2], pad.axes[3], dz))

/** Whether a pad button is down, or went down this frame (`pressed`, DeviceInput.padPressed). */
export const down = (buttons: number, b: number) => ((buttons >>> b) & 1) === 1
export const newly = (now: number, before: number) => now & ~before

/** The pad's Guide button (⌂ on the gamepad): Home on every device. */
export const GUIDE = PadButton.Guide

/**
 * The trackpad as a stick that floats: where the finger lands is the centre, and dragging from there deflects it, fully
 * at `reach` px. Dragged past the rim, the centre follows the finger, so pulling back answers at once. Lifting the
 * finger centres it. Returns [x + right, y + down], −1…1.
 */
export class DragStick {
  private at: [number, number] = [0, 0]
  constructor(public reach = 90) {}

  update(touching: boolean, drag: readonly [number, number]): [number, number] {
    if (!touching) { this.at = [0, 0]; return [0, 0] }
    this.at[0] += drag[0]
    this.at[1] += drag[1]
    const m = Math.hypot(this.at[0], this.at[1])
    if (m > this.reach) { this.at[0] *= this.reach / m; this.at[1] *= this.reach / m }
    return [this.at[0] / this.reach, this.at[1] / this.reach]
  }
}

/** How far a 1:1 turn went round the screen's own axis, like a dial (degrees, + counter-clockwise as seen). */
export const dialOf = (q: Quat) => 2 * Math.atan2(q[2], q[3]) * R2D

/**
 * A 1:1 turn as the slope of a tray held in the hand: which way (and how steeply, the sine of its angle) something on
 * it would roll, [+ right, + toward the person]. The view frame is x right, y up, z toward the person.
 */
export function slopeOf(q: Quat): [number, number] {
  const n = qRotate(q, [0, 1, 0])
  return [n[0], n[2]]
}

/**
 * A 1:1 turn as a camera's pan and tilt (radians): how far the phone turned left (+) about the vertical, then how far it
 * tipped up (+), as three.js's YXZ order reads it.
 */
export function panTiltOf(q: Quat): [number, number] {
  const [x, y, z, w] = q
  const m23 = 2 * (y * z - w * x)
  return [Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y)), Math.asin(-clamp(m23, -1, 1))]
}

/** A servo's move this frame: toward `target` at most `rate` a second, stopping on it. */
export function approach(cur: number, target: number, rate: number, dt: number): number {
  const d = target - cur
  const step = rate * dt
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step
}

/** An angle wrapped to −180…180. */
export const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180
/** An angle wrapped to −π…π. */
export const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** A readout at a glance: whole from 100, one decimal from 1, two below it, no trailing zeros. */
export function readable(v: number): string {
  const a = Math.abs(v)
  if (!Number.isFinite(v)) return '—'
  if (a < 0.005) return '0'
  return String(Number(v.toFixed(a >= 100 ? 0 : a >= 1 ? 1 : 2)))
}
