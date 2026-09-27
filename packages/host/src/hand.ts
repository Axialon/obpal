/**
 * 3D following (mode 6, Frame.pose): a tracked phone's movement in the hand's own terms, for any host. When the
 * thumb goes down, the direction the phone points becomes "toward the screen"; from then on a move is so much right,
 * up and forward, and a
 * turn is so much tip and twist, whichever way the person stands.
 */
import { qConj, qMul, qRotate, type Quat, type Vec3 } from '@obpal/core'

const R2D = 180 / Math.PI

/**
 * Which way the phone points, as a heading about the vertical (radians; 0 is −z). Held upright, the camera points;
 * held flat like a remote, the top edge does.
 */
export function headingOf(q: Quat): number {
  let f = qRotate(q, [0, 0, -1])
  if (Math.hypot(f[0], f[2]) < 0.5) f = qRotate(q, [0, 1, 0])
  return Math.atan2(-f[0], -f[2])
}

/** A move `d` (tracking space, y up) as right, up and forward for someone facing `heading`. */
export function handMove(d: Vec3, heading: number): { right: number; up: number; forward: number } {
  const c = Math.cos(heading)
  const s = Math.sin(heading)
  return { right: d[0] * c - d[2] * s, up: d[1], forward: -d[0] * s - d[2] * c }
}

/** How the phone turned from `q0` to `q`, in the hand's frame: tip (front up +) and twist (clockwise as held +), degrees. */
export function handTurn(q0: Quat, q: Quat, heading: number): { tip: number; twist: number } {
  // The turn in tracking space, then seen from someone facing `heading`.
  const d = qMul(q, qConj(q0))
  const h: Quat = [0, Math.sin(-heading / 2), 0, Math.cos(-heading / 2)]
  const [x, y, z, w] = qMul(qMul(h, d), qConj(h))
  // YXZ Euler: tip is about the hand's right axis (x), twist about its forward axis (−z).
  const tip = Math.asin(Math.max(-1, Math.min(1, 2 * (w * x - y * z)))) * R2D
  const twist = -Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z)) * R2D
  return { tip, twist }
}
