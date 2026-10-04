/** Body-frame inertia for torque servos; not a coupled articulation/contact solver. */
import { rotate, capped, norm, unit, dot, add, sub, scale, type Vec3 } from './math'
import type { Body, BodyState } from './schema'
export function bodyInertia(b: Body): Vec3 {
  if (b.fixed || b.shape.kind === 'plane') return { x: 0, y: 0, z: 0 }
  if (b.inertia) return { ...b.inertia }
  if (b.shape.kind === 'sphere') { const i = .4 * b.mass * b.shape.radius ** 2; return { x: i, y: i, z: i } }
  const h = b.shape.half, k = b.mass / 3
  return { x: k * (h.y ** 2 + h.z ** 2), y: k * (h.x ** 2 + h.z ** 2), z: k * (h.x ** 2 + h.y ** 2) }
}
function inverseTensor(b: Body, s: BodyState) {
  if (b.fixed) return { xx: 0, xy: 0, xz: 0, yy: 0, yz: 0, zz: 0 }
  const i = bodyInertia(b), x = rotate(s.rotation, { x: 1, y: 0, z: 0 }),
    y = rotate(s.rotation, { x: 0, y: 1, z: 0 }), z = rotate(s.rotation, { x: 0, y: 0, z: 1 })
  return { xx: x.x * x.x / i.x + y.x * y.x / i.y + z.x * z.x / i.z,
    xy: x.x * x.y / i.x + y.x * y.y / i.y + z.x * z.y / i.z,
    xz: x.x * x.z / i.x + y.x * y.z / i.y + z.x * z.z / i.z,
    yy: x.y * x.y / i.x + y.y * y.y / i.y + z.y * z.y / i.z,
    yz: x.y * x.z / i.x + y.y * y.z / i.y + z.y * z.z / i.z,
    zz: x.z * x.z / i.x + y.z * y.z / i.y + z.z * z.z / i.z }
}
/** Implicit free-body PD using the full rotated inertia tensor; effort remains equal/opposite and capped.
 * Other-link/contact coupling is still omitted. Native acceptance, not this approximation, gates release. */
export function dampedServo(a: Body, sa: BodyState, b: Body, sb: BodyState, error: Vec3, velocity: Vec3,
  stiffness: number, damping: number, maxTorque: number, dt: number, stop?: Vec3): Vec3 {
  if (!Number.isFinite(dt) || dt <= 0) throw new RangeError('Invalid servo timestep')
  const ia = inverseTensor(a, sa), ib = inverseTensor(b, sb), factor = damping * dt + stiffness * dt * dt
  const xx = 1 + factor * (ia.xx + ib.xx), xy = factor * (ia.xy + ib.xy), xz = factor * (ia.xz + ib.xz),
    yy = 1 + factor * (ia.yy + ib.yy), yz = factor * (ia.yz + ib.yz), zz = 1 + factor * (ia.zz + ib.zz)
  const d = damping + stiffness * dt
  let rhs = { x: stiffness * error.x - d * velocity.x,
    y: stiffness * error.y - d * velocity.y, z: stiffness * error.z - d * velocity.z }
  // Cholesky solve of the symmetric positive definite 3x3 implicit step.
  const l00 = Math.sqrt(xx), l10 = xy / l00, l20 = xz / l00
  const l11 = Math.sqrt(yy - l10 * l10), l21 = (yz - l20 * l10) / l11
  const l22 = Math.sqrt(zz - l20 * l20 - l21 * l21)
  const solve = (v: Vec3) => {
    const y0 = v.x / l00, y1 = (v.y - l10 * y0) / l11, y2 = (v.z - l20 * y0 - l21 * y1) / l22
    const z = y2 / l22, y = (y1 - l21 * z) / l11, x = (y0 - l10 * y - l20 * z) / l00
    return { x, y, z }
  }
  let out: Vec3
  if (stop && norm(stop) > 1e-8) {
    const n = unit(stop), speed = dot(velocity, n), stopDamping = speed < 0 ? 30 : 0
    // Motor and stop share one implicit step. Solving each separately spends the same inertia twice.
    rhs = add(rhs, scale(n, 1200 * norm(stop) - (stopDamping + 1200 * dt) * speed))
    const c = stopDamping * dt + 1200 * dt * dt
    const an = { x: (ia.xx + ib.xx) * n.x + (ia.xy + ib.xy) * n.y + (ia.xz + ib.xz) * n.z,
      y: (ia.xy + ib.xy) * n.x + (ia.yy + ib.yy) * n.y + (ia.yz + ib.yz) * n.z,
      z: (ia.xz + ib.xz) * n.x + (ia.yz + ib.yz) * n.y + (ia.zz + ib.zz) * n.z }
    const u = solve(n), base = solve(rhs)
    // Sherman-Morrison adds the directional stop's rank-one stiffness/damping to the motor solve.
    out = sub(base, scale(u, c * dot(an, base) / (1 + c * dot(an, u))))
  } else out = solve(rhs)
  return capped(out, maxTorque)
}
