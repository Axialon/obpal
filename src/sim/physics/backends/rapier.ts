/** Pinned Rapier compat backend. Importing this module alone does not instantiate WASM. */
import type { RigidBody, Collider } from '@dimforge/rapier3d-compat'
import type { Backend, BackendFactory, ContactSample } from '../schema'
import { cross, sub, localPoint, scale } from '../math'
type Rapier = typeof import('@dimforge/rapier3d-compat')
let loaded: Promise<Rapier> | undefined
async function load(): Promise<Rapier> {
  if (!loaded) loaded = import('@dimforge/rapier3d-compat').then(async R => { await R.init(); return R }).catch(error => { loaded = undefined; throw error })
  return loaded
}
export const createRapierBackend: BackendFactory = async (scene, _limits): Promise<Backend> => {
  const R = await load(), world = new R.World(scene.gravity), bodies = new Map<string, RigidBody>()
  const colliders = new Map<string, Collider>(), owners = new Map<number, string>()
  let disposed = false
  const dispose = () => { if (disposed) return; disposed = true; bodies.clear(); colliders.clear(); owners.clear(); world.free() }
  const body = (id: string) => { if (disposed) throw new Error('Rapier backend disposed'); const b = bodies.get(id); if (!b) throw new RangeError('Unknown Rapier body'); return b }
  try {
    world.numSolverIterations = scene.contact?.solverIterations ?? 8
    if (scene.contact) {
      // In 0.21 this is geometric slop, not a contact-bias deadzone; the fixed-floor sink fixture is unchanged.
      world.integrationParameters.normalizedAllowedLinearError = scene.contact.allowedLinearError
      // Native prediction changes prospective contact generation; observers also use this as their loaded-contact threshold.
      world.integrationParameters.normalizedPredictionDistance = scene.contact.predictionDistance
    }
    for (const b of scene.bodies) {
      const desc = (b.fixed ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic()).setTranslation(b.position.x, b.position.y, b.position.z)
        .setRotation(b.rotation).setLinvel(b.velocity.x, b.velocity.y, b.velocity.z).setAngvel(b.angularVelocity)
        // Automatic sleeping truncates slow undamped motion and exponential damping. Explicit sleep still works.
        .setLinearDamping(b.linearDamping).setAngularDamping(b.angularDamping).setCanSleep(false)
      const native = world.createRigidBody(desc); bodies.set(b.id, native)
      const collider = b.shape.kind === 'sphere' ? R.ColliderDesc.ball(b.shape.radius) : b.shape.kind === 'box' ?
        R.ColliderDesc.cuboid(b.shape.half.x, b.shape.half.y, b.shape.half.z) : new R.ColliderDesc(new R.HalfSpace({ x: 0, y: 1, z: 0 }))
      // Encode sqrt(mu) with Multiply to match the common geometric-mean pair law.
      collider.setFriction(Math.sqrt(b.friction)).setFrictionCombineRule(R.CoefficientCombineRule.Multiply)
        .setRestitution(b.restitution).setRestitutionCombineRule(R.CoefficientCombineRule.Min)
      if (!b.fixed) {
        if (b.inertia) collider.setMassProperties(b.mass, { x: 0, y: 0, z: 0 }, b.inertia, { x: 0, y: 0, z: 0, w: 1 })
        else collider.setMass(b.mass)
      }
      const created = world.createCollider(collider, native)
      colliders.set(b.id, created); owners.set(created.handle, b.id)
    }
    // Spherical multibody joints in this binding start at zero generalized rotation and snap displaced
    // children to that pose. Impulse joints constrain the anchors while preserving supplied rotations/velocities.
    const remaining = [...scene.joints], completed = new Set(scene.bodies.filter(b => !scene.joints.some(j => j.child === b.id)).map(b => b.id))
    while (remaining.length) {
      const index = remaining.findIndex(j => completed.has(j.parent))
      if (index < 0) throw new Error('Invalid articulated ordering')
      const [j] = remaining.splice(index, 1), data = R.JointData.spherical(j.anchorParent, j.anchorChild)
      const joint = world.createImpulseJoint(data, body(j.parent), body(j.child), true)
      joint.setContactsEnabled(false); completed.add(j.child)
    }
    return {
      id: 'rapier', version: `@dimforge/rapier3d-compat@0.21.0 / ${R.version()}`,
      capabilities: { contacts: 'sphere, box and infinite half-space', articulation: 'native spherical impulse-joint tree (maximal coordinates)', motor: 'bounded-torque',
        cones: 'common compliant elliptical swing/twist stop', wheels: 'static-ray-suspension', buoyancy: 'sampled-displacement',
        unsupported: ['compound or mesh colliders in this adapter', 'reduced-coordinate articulation in this adapter', 'native spherical motor drive', 'dynamic tyre terrain', 'CCD in this adapter'] },
      read(id) { const b = body(id); return { id, position: { ...b.translation() }, rotation: { ...b.rotation() }, velocity: { ...b.linvel() },
        angularVelocity: { ...b.angvel() }, sleeping: b.isFixed() || b.isSleeping() } },
      force(id, f, p) { const b = body(id); if (!b.isFixed()) { b.addForce(f, false); b.addTorque(cross(sub(p, b.translation()), f), false) } },
      torque(id, t) { const b = body(id); if (!b.isFixed()) b.addTorque(t, false) },
      sleep(id, sleeping) { const b = body(id); if (b.isFixed()) return; if (sleeping) b.sleep(); else b.wakeUp() },
      step(dt) {
        if (disposed) throw new Error('Rapier backend disposed')
        world.timestep = dt
        try { world.step() } finally { for (const b of bodies.values()) if (!b.isFixed()) { b.resetForces(false); b.resetTorques(false) } }
      },
      contacts() {
        if (disposed) throw new Error('Rapier backend disposed')
        const out: ContactSample[] = []
        // No manifolds escape this synchronous callback. Each unordered pair is sampled exactly once.
        for (const [a, ca] of colliders) world.contactPairsWith(ca, cb => {
          const b = owners.get(cb.handle)
          if (!b) throw new Error('Unknown contact collider')
          if (a >= b) return
          world.contactPair(ca, cb, (m, flipped) => {
            const normal = { ...m.normal() }, ba = body(a), bb = body(b)
            for (let i = 0; i < m.numContacts(); i++) {
              if (out.length >= 256) throw new RangeError('Contact sample budget exceeded')
              const pa = flipped ? m.localContactPoint2(i) : m.localContactPoint1(i)
              const pb = flipped ? m.localContactPoint1(i) : m.localContactPoint2(i)
              // Null means that this contact index has no native point, not a point at the body origin.
              // An index inside numContacts must exist; fail rather than fabricate or omit support.
              if (pa === null || pb === null) throw new Error('Rapier manifold contact point unavailable')
              out.push({ a, b, pointA: localPoint(ba.translation(), ba.rotation(), pa),
                pointB: localPoint(bb.translation(), bb.rotation(), pb), normalOnB: scale(normal, flipped ? -1 : 1),
                distance: m.contactDist(i), impulse: m.contactImpulse(i) })
            }
          })
        })
        return out
      },
      memoryBytes: () => null, // Compat does not expose per-world or total WASM allocation accounting as a public API.
      dispose,
    }
  } catch (error) { dispose(); throw error }
}
