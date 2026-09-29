/** Analytic two-link IK and forward kinematics shared by named chain profiles. */
import { Vector3, Quaternion, Matrix4, Euler } from 'three'
import type { Vec3 } from '@obpal/core'
import { clamp, type Angles, type RigProfile } from './profile'
export const v = (p: readonly number[]) => new Vector3(p[0], p[1], p[2])
export interface Transform {
  p: Vector3
  q: Quaternion
}
export function forward(profile: RigProfile, angles: Angles): Map<string, Transform> {
  const out = new Map<string, Transform>()
  for (const j of profile.joints) {
    const parent = j.parent ? out.get(j.parent) : undefined
    const q = parent?.q.clone() ?? new Quaternion(),
      p = v(j.offset)
        .applyQuaternion(q)
        .add(parent?.p ?? new Vector3())
    q.multiply(new Quaternion().setFromAxisAngle(v(j.axis), angles[j.id] || 0))
    out.set(j.id, { p, q })
  }
  return out
}
export function solveLimb(target: Vector3, pole: Vector3, a: number, b: number, bend = 1) {
  const d = clamp(target.length(), Math.abs(a - b) + 1e-6, a + b - 1e-6)
  const along = target.lengthSq() > 1e-10 ? target.clone().normalize() : new Vector3(0, -1, 0)
  let across = pole.clone().addScaledVector(along, -pole.dot(along))
  if (across.lengthSq() < 1e-8) across = new Vector3(0, 0, -1).addScaledVector(along, along.z)
  if (across.lengthSq() < 1e-8) across = new Vector3(1, 0, 0).addScaledVector(along, -along.x)
  across.normalize()
  const x = (a * a + d * d - b * b) / (2 * d),
    h = Math.sqrt(Math.max(0, a * a - x * x))
  const middle = along.clone().multiplyScalar(x).addScaledVector(across, h),
    end = along.clone().multiplyScalar(d)
  const upper = middle.clone().normalize(),
    lower = end.clone().sub(middle).normalize()
  const axis = new Vector3().crossVectors(upper, lower).multiplyScalar(bend).normalize()
  const up = upper.clone().negate(),
    back = new Vector3().crossVectors(axis, up).normalize()
  const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(axis, up, back))
  const e = new Euler().setFromQuaternion(rotation, 'ZXY')
  return {
    middle,
    end,
    rotation,
    roll: e.z,
    pitch: e.x,
    yaw: e.y,
    flex: Math.acos(clamp((d * d - a * a - b * b) / (2 * a * b), -1, 1)),
    residual: Math.abs(target.length() - d),
  }
}
/** A proper right-handed frame even when the body turns; never reflect a quaternion. */
export function bodyFrame(right: Vector3, vertical: Vector3): Quaternion | null {
  if (right.lengthSq() < 1e-8 || vertical.lengthSq() < 1e-8) return null
  const r = right.clone().normalize(),
    u = vertical.clone().addScaledVector(r, -vertical.dot(r))
  if (u.lengthSq() < 1e-8) return null
  u.normalize()
  const b = new Vector3().crossVectors(r, u).normalize()
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(r, u, b))
}
const PAIRS = [
  [1, 4],
  [2, 5],
  [3, 6],
  [7, 8],
  [9, 10],
  [11, 12],
  [13, 14],
  [15, 16],
  [17, 18],
  [19, 20],
  [21, 22],
  [23, 24],
  [25, 26],
  [27, 28],
  [29, 30],
  [31, 32],
]
export function mirrorPoints(points: readonly Vec3[]): Vec3[] {
  const out = points.map(([x, y, z]): Vec3 => [-x, y, z])
  for (const [a, b] of PAIRS) [out[a], out[b]] = [out[b], out[a]]
  return out
}
export function mirrorScores(scores: readonly number[]) {
  const out = [...scores]
  for (const [a, b] of PAIRS) [out[a], out[b]] = [out[b], out[a]]
  return out
}
