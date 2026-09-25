import type { Vec3 } from '@obpal/core'

const R2D = 180 / Math.PI
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/**
 * The user's "right" axis in the screen frame, derived from gravity alone so every grip works:
 * portrait, landscape (even with rotation lock on), upside down, or lying flat.
 * When the screen faces the user it is horizontal and perpendicular to the screen normal;
 * when the phone lies flat it is perpendicular to the top edge (the top edge points forward).
 */
export function pitchAxis(up: Vec3): Vec3 {
  const facing = cross(up, [0, 0, 1])
  const flat = cross([0, 1, 0], up)
  const fl = len(facing)
  const w = smoothstep(0.2, 0.45, fl)
  const a = fl > 1e-6 ? facing.map((c) => (c / fl) * w) : [0, 0, 0]
  const lf = len(flat) || 1
  const v: Vec3 = [a[0] + (flat[0] / lf) * (1 - w), a[1] + (flat[1] / lf) * (1 - w), a[2] + (flat[2] / lf) * (1 - w)]
  const l = len(v) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/**
 * Game-controller style gyro (JibbSmart "player space", generalized to any phone grip):
 * pitch is rotation about the user's right axis; yaw is rotation about gravity with a relaxed axis,
 * so turning the wrist naturally counts even when the phone is tilted. Roll is ignored.
 * Returns degrees/second: yaw + = turning left, pitch + = aiming up.
 */
export function playerSpaceRates(gyro: Vec3, up: Vec3): [number, number] {
  const right = pitchAxis(up)
  const pitch = dot(gyro, right)
  const perp: Vec3 = [gyro[0] - right[0] * pitch, gyro[1] - right[1] * pitch, gyro[2] - right[2] * pitch]
  const worldYaw = dot(perp, up)
  const yaw = Math.sign(worldYaw) * Math.min(Math.abs(worldYaw) * 1.41, len(perp))
  return [yaw * R2D, pitch * R2D]
}

/** Human-readable grip, for diagnostics. */
export function gripName(up: Vec3): 'flat' | 'portrait' | 'landscape' {
  if (Math.abs(up[2]) > 0.85) return 'flat'
  return Math.abs(up[0]) > Math.abs(up[1]) ? 'landscape' : 'portrait'
}

/**
 * Keeps gyro aiming crisp: raw rates for deliberate motion, light smoothing only for tiny motion,
 * and tightening that damps hand tremor when the phone is held nearly still.
 */
export class GyroSmoother {
  private ema: [number, number] = [0, 0]
  constructor(public smoothBelow = 8, public tighten = 1.2) {}

  reset() { this.ema = [0, 0] }

  apply(yaw: number, pitch: number): [number, number] {
    this.ema[0] += (yaw - this.ema[0]) * 0.35
    this.ema[1] += (pitch - this.ema[1]) * 0.35
    const raw = Math.min(1, Math.max(0, (Math.hypot(yaw, pitch) - this.smoothBelow / 4) / this.smoothBelow))
    let y = yaw * raw + this.ema[0] * (1 - raw)
    let p = pitch * raw + this.ema[1] * (1 - raw)
    const m = Math.hypot(y, p)
    if (m < this.tighten) {
      const k = m / this.tighten
      y *= k
      p *= k
    }
    return [y, p]
  }
}

/**
 * Racing-style tilt stick. The pose when the gyro is switched on (or re-levelled) is neutral; tilting away
 * from it gives a stick deflection that keeps the target moving until the phone is level again.
 * Grip-agnostic: angles are measured about the user's right and forward axes, derived from gravity.
 */
export class TiltStick {
  private u0: Vec3 | null = null
  private right: Vec3 = [1, 0, 0]
  private forward: Vec3 = [0, 0, -1]
  constructor(public dead = 4, public sat = 30, public expo = 1.6) {}

  capture(up: Vec3) {
    this.u0 = up
    this.right = pitchAxis(up)
    this.forward = cross(up, this.right)
  }

  get ready() { return this.u0 !== null }

  /** Degrees from neutral: [steer (+ = right, like turning a wheel clockwise), pitch (+ = top edge toward the user)]. */
  angles(up: Vec3): [number, number] {
    if (!this.u0) return [0, 0]
    const c = dot(up, this.u0)
    return [Math.atan2(-dot(up, this.right), c) * R2D, Math.atan2(dot(up, this.forward), c) * R2D]
  }

  /** Stick in [-1, 1] after deadzone, saturation and expo. gain > 1 reaches full speed with less tilt. */
  stick(up: Vec3, gain = 1): [number, number] {
    const shape = (deg: number) => {
      const m = (Math.abs(deg) * gain - this.dead) / (this.sat - this.dead)
      return m <= 0 ? 0 : Math.sign(deg) * Math.pow(Math.min(1, m), this.expo)
    }
    const [a, b] = this.angles(up)
    return [shape(a), shape(b)]
  }
}
