/**
 * Response maths of the control catalogue (spec/CATALOGUE.md §2): how a motion utility's raw signal becomes a
 * stick deflection. Pure; used by the phone (mixing into PAD) and by hosts that finish a route themselves.
 *
 *   raw unit vector  ─ gain ─ curve ─ invert ─▶  contribution
 *   thumb + contributions ─ clamp to the unit circle ─ deadzone jump ─▶  the stick a game reads
 */
export type Vec2 = [number, number]

export interface Response {
  /** Sensitivity multiplier. */
  gain: number
  /** Exponent on the magnitude before the deadzone jump; above 1 is finer near the centre. */
  curve: number
  /** The game's own stick deadzone to jump over. */
  deadzone: number
  invertY: boolean
}

export const DEFAULT_RESPONSE: Response = { gain: 1, curve: 1, deadzone: 0.2, invertY: false }

/** Turning the phone this fast (degrees/second) is a full deflection at gain 1. */
export const FULL_RATE_DPS = 180
/**
 * Motion below this (as a fraction of full travel, 0.01 = 1.8°/s) counts as a still phone, so sensor noise
 * never rides the deadzone jump into the game.
 */
export const REST = 0.01

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Player-space turn rates (yaw + = left, pitch + = up, °/s) as a raw stick vector (+x right, +y down). */
export function rateToUnit(yawDps: number, pitchDps: number, full = FULL_RATE_DPS): Vec2 {
  return [clamp(-yawDps / full, -1, 1), clamp(-pitchDps / full, -1, 1)]
}

/**
 * Gain, then the curve on the magnitude (the direction is kept, so a pure yaw stays a pure yaw), clamped to the
 * unit circle; invertY flips the vertical axis.
 */
export function shapeVector(v: Vec2, r: Pick<Response, 'gain' | 'curve' | 'invertY'>): Vec2 {
  const x = v[0] * r.gain
  const y = v[1] * r.gain
  const m = Math.hypot(x, y)
  if (m === 0) return [0, 0]
  const k = Math.pow(Math.min(1, m), r.curve) / m
  return [x * k, y * k * (r.invertY ? -1 : 1)]
}

/**
 * The deadzone jump: `sign(v) · (d + (1 − d) · |v|)` applied to the vector's magnitude, so any deliberate motion
 * lands past the game's deadzone `d` while the direction stays exact. Below `rest` the phone counts as still.
 */
export function jumpDeadzone(v: Vec2, d: number, rest = REST): Vec2 {
  const m = Math.hypot(v[0], v[1])
  if (m <= rest) return [0, 0]
  const out = d + (1 - d) * Math.min(1, m)
  return [(v[0] / m) * out, (v[1] / m) * out]
}

/** Sum of stick vectors, clamped to the unit circle (a thumb plus motion can't exceed a full deflection). */
export function addStick(a: Vec2, b: Vec2): Vec2 {
  const x = a[0] + b[0]
  const y = a[1] + b[1]
  const m = Math.hypot(x, y)
  return m > 1 ? [x / m, y / m] : [x, y]
}

/** A motion utility's shaped contribution to a stick, with the deadzone it wants jumped. */
export interface Contribution { v: Vec2; deadzone: number }

/**
 * What a stick finally carries: the thumb alone when no motion contributes, otherwise the thumb plus every
 * contribution, clamped, then one deadzone jump (the largest requested), so two small inputs never jump twice.
 */
export function mixStick(thumb: Vec2, motions: readonly Contribution[]): Vec2 {
  let sum: Vec2 = [0, 0]
  let d = 0
  let live = false
  for (const m of motions) {
    if (m.v[0] === 0 && m.v[1] === 0) continue
    live = true
    sum = addStick(sum, m.v)
    d = Math.max(d, m.deadzone)
  }
  if (!live) return [thumb[0], thumb[1]]
  return jumpDeadzone(addStick(thumb, sum), d)
}

/**
 * Yoke-style flight from the tilt stick: tilting left or right is X, tipping forward or back is Y. Pulling the top
 * edge toward you (tilt pitch +) is nose up, which is stick up (−Y) as in most flight games; invertY flips it.
 */
export function flyVector(tilt: readonly [number, number]): Vec2 {
  return [tilt[0], -tilt[1]]
}

/** Steering-wheel from the tilt stick: tilting left or right is X, nothing on Y. */
export function wheelVector(tilt: readonly [number, number]): Vec2 {
  return [tilt[0], 0]
}
