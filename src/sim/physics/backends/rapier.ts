/** Pinned Rapier compat backend. Importing this module alone does not instantiate WASM. */
import type { RigidBody } from '@dimforge/rapier3d-compat'
import type { Backend, BackendFactory } from '../schema'
import { cross, sub } from '../math'
type Rapier = typeof import('@dimforge/rapier3d-compat')
let loaded: Promise<Rapier> | undefined
async function load(): Promise<Rapier> {
  if (!loaded) loaded = import('@dimforge/rapier3d-compat').then(async R => { await R.init(); return R }).catch(error => { loaded = undefined; throw error })
  return loaded
}
export const createRapierBackend: BackendFactory = async (scene, _limits): Promise<Backend> => {
  const R = await load(), world = new R.World(scene.gravity), bodies = new Map<string, RigidBody>()
  let disposed = false
  const dispose = () => { if (disposed) return; disposed = true; bodies.clear(); world.free() }
  const body = (id: string) => { if (disposed) throw new Error('Rapier backend disposed'); const b = bodies.get(id); if (!b) throw new RangeError('Unknown Rapier body'); return b }
  try {
    world.numSolverIterations = 8
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
      if (!b.fixed) collider.setMass(b.mass)
      world.createCollider(collider, native)
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
      memoryBytes: () => null, // Compat does not expose per-world or total WASM allocation accounting as a public API.
      dispose,
    }
  } catch (error) { dispose(); throw error }
}
