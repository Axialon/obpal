/** Native single-foot fixture. The payload is a maximal-coordinate joint load, not added foot mass. */
import R from '@dimforge/rapier3d-compat'
import { rotate } from '../src/sim/physics/math'
import type { Vec3 } from '../src/sim/physics/schema'

export const CONTACT_FEET = {
  keel: { x: .09, y: .055, z: .16 },
  morrow: { x: .09 * 11 / 12, y: .055 * 11 / 12, z: .16 * 11 / 12 },
} as const
export interface ContactSinkOptions {
  half: Vec3
  mass: number
  inertiaScale: number
  offset: number
  tiles?: 1 | 2
  legacyMaterial?: boolean
  seconds?: number
  settings?: { allowed?: number; prediction?: number; length?: number; frequency?: number }
}
const ZERO = { x: 0, y: 0, z: 0 }, IDENTITY = { x: 0, y: 0, z: 0, w: 1 }

/** The fitted 60 Hz contact spring law is asserted only at three times uniform inertia. */
export function predictedCornerMm(o: ContactSinkOptions) {
  const h = o.half, k = o.mass * o.inertiaScale / 3
  const ix = k * (h.y ** 2 + h.z ** 2), iz = k * (h.x ** 2 + h.y ** 2)
  const effectiveMass = 1 / (1 / o.mass + h.z ** 2 / ix + h.x ** 2 / iz)
  return 59.5 * 9.81 / (4 * effectiveMass * 1.425e5) * (1 + Math.abs(o.offset)) * 1000
}

export function measureContactSink(o: ContactSinkOptions) {
  const h = o.half, world = new R.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = 1 / 240; world.numSolverIterations = 16
  world.integrationParameters.normalizedAllowedLinearError = o.settings?.allowed ?? .0002
  world.integrationParameters.normalizedPredictionDistance = o.settings?.prediction ?? .001
  if (o.settings?.length !== undefined) world.integrationParameters.lengthUnit = o.settings.length
  if (o.settings?.frequency !== undefined) world.integrationParameters.contact_natural_frequency = o.settings.frequency
  const material = (desc: R.ColliderDesc) => o.legacyMaterial ? desc : desc.setFriction(Math.sqrt(.8))
    .setFrictionCombineRule(R.CoefficientCombineRule.Multiply).setRestitution(0).setRestitutionCombineRule(R.CoefficientCombineRule.Min)
  const dynamic = (x: number, y: number, z: number) => R.RigidBodyDesc.dynamic().setTranslation(x, y, z).setCanSleep(false)
    .setLinearDamping(o.legacyMaterial ? 0 : .02).setAngularDamping(o.legacyMaterial ? 0 : .02)
  try {
    const floor = world.createCollider(material(new R.ColliderDesc(new R.HalfSpace({ x: 0, y: 1, z: 0 }))), world.createRigidBody(R.RigidBodyDesc.fixed()))
    const y0 = h.y + .002, offsetZ = o.offset * h.z
    const payload = world.createRigidBody(dynamic(0, y0 + .8, offsetZ))
    world.createCollider(material(R.ColliderDesc.ball(.12).setMass(59.5 - o.mass)), payload)
    const foot = world.createRigidBody(dynamic(0, y0, 0)), tiles = o.tiles ?? 1
    const colliders: R.Collider[] = [], count = tiles * tiles, mass = o.mass / count
    for (let x = 0; x < tiles; x++) for (let z = 0; z < tiles; z++) {
      const hx = h.x / tiles, hz = h.z / tiles, dx = -h.x + hx * (2 * x + 1), dz = -h.z + hz * (2 * z + 1)
      const collider = material(R.ColliderDesc.cuboid(hx, h.y, hz).setTranslation(dx, 0, dz))
      if (o.inertiaScale === 1) collider.setMass(mass)
      else {
        // Subtract each tile's parallel-axis term so the assembled inertia remains the requested whole-box inertia.
        const k = mass * o.inertiaScale / 3
        collider.setMassProperties(mass, ZERO, { x: k * (h.y ** 2 + h.z ** 2) - mass * dz ** 2,
          y: k * (h.x ** 2 + h.z ** 2) - mass * (dx ** 2 + dz ** 2), z: k * (h.x ** 2 + h.y ** 2) - mass * dx ** 2 }, IDENTITY)
      }
      colliders.push(world.createCollider(collider, foot))
    }
    world.createImpulseJoint(R.JointData.fixed({ x: 0, y: -.8, z: -offsetZ }, IDENTITY, ZERO, IDENTITY), payload, foot, true).setContactsEnabled(false)
    const trajectory: number[] = [], ticks = Math.round((o.seconds ?? 1.5) * 240)
    let peakMm = 0, endMm = 0, maxTiltDeg = 0, minPayloadY = Infinity, points = 0
    for (let tick = 0; tick < ticks; tick++) {
      world.step()
      const p = foot.translation(), q = foot.rotation(), pp = payload.translation(), pq = payload.rotation()
      let minY = Infinity
      for (const x of [-h.x, h.x]) for (const z of [-h.z, h.z]) minY = Math.min(minY, p.y + rotate(q, { x, y: -h.y, z }).y)
      endMm = -minY * 1000; peakMm = Math.max(peakMm, endMm)
      maxTiltDeg = Math.max(maxTiltDeg, 2 * Math.asin(Math.min(1, Math.hypot(q.x, q.z))) * 180 / Math.PI)
      minPayloadY = Math.min(minPayloadY, pp.y)
      trajectory.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w, pp.x, pp.y, pp.z, pq.x, pq.y, pq.z, pq.w)
    }
    for (const collider of colliders) world.contactPair(floor, collider, manifold => { points += manifold.numContacts() })
    const principal = foot.principalInertia(), frame = foot.principalInertiaLocalFrame()
    const axes = [rotate(frame, { x: 1, y: 0, z: 0 }), rotate(frame, { x: 0, y: 1, z: 0 }), rotate(frame, { x: 0, y: 0, z: 1 })]
    const inertia = { x: 0, y: 0, z: 0 }
    for (const axis of ['x', 'y', 'z'] as const) inertia[axis] = axes[0][axis] ** 2 * principal.x + axes[1][axis] ** 2 * principal.y + axes[2][axis] ** 2 * principal.z
    return { peakMm, endMm, maxTiltDeg, minPayloadY, points, mass: foot.mass(), inertia,
      localCom: { ...foot.localCom() }, topples: maxTiltDeg > 30 || minPayloadY < y0 + .55, trajectory }
  } finally { world.free() }
}
