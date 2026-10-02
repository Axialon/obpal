/** Orchestration-only double: not contact/energy/stance evidence. Never imported by a product entry. */
import type { BackendFactory } from '../src/sim/physics/schema'
export const orchestrationBackend: BackendFactory = async scene => {
  const states = new Map(scene.bodies.map(b => [b.id, { id: b.id, position: { ...b.position }, rotation: { ...b.rotation },
    velocity: { ...b.velocity }, angularVelocity: { ...b.angularVelocity }, sleeping: b.fixed }]))
  return { id: 'custom', version: 'TEST DOUBLE - NOT PHYSICS', capabilities: { contacts: 'none: orchestration double', articulation: 'none', motor: 'bounded-torque',
    cones: 'none', wheels: 'static-ray-suspension', buoyancy: 'sampled-displacement', unsupported: ['physical acceptance'] },
    read: id => structuredClone(states.get(id)!), force() {}, torque() {}, sleep() {}, memoryBytes: () => null, contacts: () => [],
    step() { for (const b of scene.bodies) if (!b.fixed) states.get(b.id)!.position.x += .000001 }, dispose() {} }
}
