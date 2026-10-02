/** Contact-driven observations. Sole geometry describes error; it never manufactures support or changes a body. */
import { STEP, type BodyState, type ContactSample } from '../../physics/schema'
import { add, scale, sub, norm, dot, localPoint, multiply, conjugate, quaternion, rotate, angleBetween, type Vec3 } from '../../physics/math'
import { soleCorners, type PhysicalHumanoid } from './model'
export interface Observation {
  schema_version: 1; modelVersion: string; profileId: string; actorId: string; generation: number; stateTick: number; timeS: number
  bodies: BodyState[]; com: Vec3
  joints: { id: string; rotation: BodyState['rotation']; angularVelocity: Vec3; anchorErrorM: number }[]
  feet: { id: string; minSoleY: number; maxSoleY: number; centre: Vec3; speedMps: number }[]
  support: { points: Vec3[]; polygon: Vec3[]; marginM: number | null; normalImpulseNs: number }
}
const cross2 = (a: Vec3, b: Vec3, c: Vec3) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
function hull(points: Vec3[]) {
  const sorted = points.map(p => ({ ...p })).sort((a, b) => a.x - b.x || a.z - b.z)
    .filter((p, i, a) => !i || Math.hypot(p.x - a[i - 1].x, p.z - a[i - 1].z) > 1e-8)
  if (sorted.length <= 2) return sorted
  const half = (xs: Vec3[]) => { const out: Vec3[] = []; for (const p of xs) { while (out.length >= 2 && cross2(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop(); out.push(p) }; return out }
  return [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)]
}
export function observe(model: PhysicalHumanoid, input: readonly BodyState[], contacts: readonly ContactSample[], generation: number, tick: number): Observation {
  const states = new Map(input.map(s => [s.id, s])), get = (id: string) => { const b = states.get(id); if (!b) throw new Error(`Missing observed body ${id}`); return b }
  let mass = 0, com = { x: 0, y: 0, z: 0 }
  for (const b of model.scene.bodies) if (!b.fixed) { mass += b.mass; com = add(com, scale(get(b.id).position, b.mass)) }
  com = scale(com, 1 / mass)
  const points: Vec3[] = []; let normalImpulseNs = 0
  const loaded = new Set<string>()
  for (const c of contacts) {
    if (c.distance > (model.scene.contact?.predictionDistance ?? .001) || c.impulse <= 0) continue
    if (c.a === 'floor' && model.feet.includes(c.b) && c.normalOnB.y >= .5) loaded.add(c.b)
    if (c.b === 'floor' && model.feet.includes(c.a) && c.normalOnB.y <= -.5) loaded.add(c.a)
  }
  for (const c of contacts) {
    const footA = model.feet.includes(c.a) && c.b === 'floor', footB = model.feet.includes(c.b) && c.a === 'floor'
    if (!footA && !footB) continue
    const normal = scale(c.normalOnB, footA ? -1 : 1)
    // 60 deg upward-normal envelope is an observation default, not a recovery controller or floor-height test.
    if (!loaded.has(footA ? c.a : c.b) || normal.y < .5 || c.distance > (model.scene.contact?.predictionDistance ?? .001)) continue
    // Zero-pressure manifold points still bound the measured footprint of a foot with positive net load.
    points.push({ ...(footA ? c.pointA : c.pointB) }); normalImpulseNs += c.impulse * normal.y
  }
  const polygon = hull(points)
  const marginM = polygon.length < 3 ? null : Math.min(...polygon.map((a, i) => {
    const b = polygon[(i + 1) % polygon.length]; return cross2(a, b, com) / Math.hypot(b.x - a.x, b.z - a.z)
  }))
  return { schema_version: 1, modelVersion: model.version, profileId: model.profileId, actorId: model.actorId, generation, stateTick: tick, timeS: tick * STEP,
    bodies: structuredClone(input.filter(b => b.id !== 'floor' && model.scene.bodies.some(spec => spec.id === b.id))), com, support: { points, polygon, marginM, normalImpulseNs },
    joints: model.scene.joints.map(j => {
      const a = get(j.parent), b = get(j.child), frame = multiply(a.rotation, j.frameParent)
      return { id: j.id, rotation: quaternion(multiply(conjugate(frame), multiply(b.rotation, j.frameChild))),
        angularVelocity: rotate(conjugate(frame), sub(b.angularVelocity, a.angularVelocity)),
        anchorErrorM: norm(sub(localPoint(a.position, a.rotation, j.anchorParent), localPoint(b.position, b.rotation, j.anchorChild))) }
    }),
    feet: model.feet.map(id => {
      const b = get(id), spec = model.scene.bodies.find(b => b.id === id)!, corners = soleCorners({ ...spec, ...b })
      return { id, minSoleY: Math.min(...corners.map(p => p.y)), maxSoleY: Math.max(...corners.map(p => p.y)),
        centre: { ...b.position }, speedMps: Math.sqrt(dot(b.velocity, b.velocity)) }
    }) }
}

/** Motion evidence is joint-relative: a rigidly falling/rotating actor is not arm actuation. */
export function jointMotionRad(before: Observation, after: Observation, jointId: string): number {
  if (before.modelVersion !== after.modelVersion || before.profileId !== after.profileId || before.actorId !== after.actorId ||
    before.generation !== after.generation || after.stateTick < before.stateTick) throw new RangeError('Motion observation identity/order mismatch')
  const a = before.joints.find(j => j.id === jointId), b = after.joints.find(j => j.id === jointId)
  if (!a || !b) throw new RangeError('Missing motion joint')
  return angleBetween(a.rotation, b.rotation)
}
