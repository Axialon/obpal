/** Small owned-value maths shared by the candidates. Quaternion order is x, y, z, w; metres/radians/seconds. */
export interface Vec3 { x: number; y: number; z: number }
export interface Quat extends Vec3 { w: number }
export interface Cone { swingY: number; swingZ: number; twistMin: number; twistMax: number }
export const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 })
export const IDENTITY: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 })
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s })
export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
export const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
export const norm = (a: Vec3) => Math.hypot(a.x, a.y, a.z)
export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
export const unit = (a: Vec3): Vec3 => { const n = norm(a); return n > 1e-12 ? scale(a, 1 / n) : { ...ZERO } }
export const capped = (a: Vec3, limit: number): Vec3 => scale(a, Math.min(1, limit / Math.max(norm(a), 1e-30)))
export const conjugate = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })
export function multiply(a: Quat, b: Quat): Quat {
  return { x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z }
}
/** Canonicalise even exactly pi rotations; q and -q must not produce opposite saturated motor commands. */
export function quaternion(q: Quat): Quat {
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  if (![q.x, q.y, q.z, q.w].every(Number.isFinite) || n < 1e-12 || n > 1e12) throw new RangeError('Invalid quaternion')
  const first = q.w || q.x || q.y || q.z, s = (first < 0 ? -1 : 1) / n
  return { x: q.x * s || 0, y: q.y * s || 0, z: q.z * s || 0, w: q.w * s || 0 }
}
export function rotate(q: Quat, v: Vec3): Vec3 {
  const t = scale(cross(q, v), 2)
  return add(v, add(scale(t, q.w), cross(q, t)))
}
export const localPoint = (p: Vec3, q: Quat, v: Vec3) => add(p, rotate(q, v))
export function fromRotationVector(v: Vec3): Quat {
  const a = norm(v)
  if (!Number.isFinite(a)) throw new RangeError('Invalid rotation vector')
  if (a < 1e-12) return { ...IDENTITY }
  const k = Math.sin(a / 2) / a
  return quaternion({ x: v.x * k, y: v.y * k, z: v.z * k, w: Math.cos(a / 2) })
}
export function rotationVector(q: Quat): Vec3 {
  q = quaternion(q)
  const n = Math.hypot(q.x, q.y, q.z), k = n < 1e-12 ? 2 : 2 * Math.atan2(n, q.w) / n
  return { x: q.x * k, y: q.y * k, z: q.z * k }
}
/** Twist is about joint X. Swing uses a rotation-vector ellipse in the joint YZ plane, not Euler angles. */
export function swingTwist(input: Quat) {
  const q = quaternion(input), d = Math.hypot(q.x, q.w)
  const twist = d < 1e-10 ? { ...IDENTITY } : quaternion({ x: q.x / d, y: 0, z: 0, w: q.w / d })
  const swing = rotationVector(multiply(q, conjugate(twist)))
  return { twist: rotationVector(twist).x, swingY: swing.y, swingZ: swing.z }
}
export function clampCone(q: Quat, c: Cone): Quat {
  const s = swingTwist(q), r = Math.hypot(s.swingY / c.swingY, s.swingZ / c.swingZ)
  const factor = r > 1 ? 1 / r : 1
  return quaternion(multiply(fromRotationVector({ x: 0, y: s.swingY * factor, z: s.swingZ * factor }),
    fromRotationVector({ x: clamp(s.twist, c.twistMin, c.twistMax), y: 0, z: 0 })))
}
export const angleBetween = (a: Quat, b: Quat) => norm(rotationVector(multiply(a, conjugate(b))))
