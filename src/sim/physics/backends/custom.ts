/** Original small position-based rigid solver. A comparison candidate, not a general replacement for Rapier. */
import { add, sub, scale, dot, cross, norm, rotate, conjugate, multiply, quaternion, fromRotationVector, rotationVector, clamp, ZERO, type Vec3 } from '../math'
import type { Backend, Body, BodyState, Scene, Limits } from '../schema'
interface Particle extends BodyState { spec: Body; inverseMass: number; inverseInertia: Vec3; force: Vec3; torque: Vec3; quiet: number }
interface Contact { a: Particle; b: Particle; normal: Vec3; ra: Vec3; rb: Vec3; depth: number }
const AXES: Vec3[] = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]
const inertia = (b: Body): Vec3 => {
  if (b.fixed) return { ...ZERO }
  if (b.inertia) return { x: 1 / b.inertia.x, y: 1 / b.inertia.y, z: 1 / b.inertia.z }
  if (b.shape.kind === 'sphere') { const k = 1 / (.4 * b.mass * b.shape.radius ** 2); return { x: k, y: k, z: k } }
  if (b.shape.kind === 'box') { const h = b.shape.half; return { x: 3 / (b.mass * (h.y ** 2 + h.z ** 2)), y: 3 / (b.mass * (h.x ** 2 + h.z ** 2)), z: 3 / (b.mass * (h.x ** 2 + h.y ** 2)) } }
  return { ...ZERO }
}
const invI = (b: Particle, v: Vec3): Vec3 => {
  const local = rotate(conjugate(b.rotation), v)
  return rotate(b.rotation, { x: local.x * b.inverseInertia.x, y: local.y * b.inverseInertia.y, z: local.z * b.inverseInertia.z })
}
const effective = (b: Particle, r: Vec3, n: Vec3) => b.inverseMass + dot(cross(r, n), invI(b, cross(r, n)))
function shift(b: Particle, r: Vec3, impulse: Vec3) {
  if (!b.inverseMass) return
  b.position = add(b.position, scale(impulse, b.inverseMass))
  const angle = invI(b, cross(r, impulse)), a = norm(angle)
  b.rotation = quaternion(multiply(fromRotationVector(scale(angle, Math.min(1, .2 / Math.max(a, 1e-30)))), b.rotation))
}
function velocityImpulse(b: Particle, r: Vec3, impulse: Vec3) {
  if (!b.inverseMass) return
  b.velocity = add(b.velocity, scale(impulse, b.inverseMass)); b.angularVelocity = add(b.angularVelocity, invI(b, cross(r, impulse)))
}
const velocityAt = (b: Particle, r: Vec3) => add(b.velocity, cross(b.angularVelocity, r))
const pairKey = (a: string, b: string) => a < b ? `${a}/${b}` : `${b}/${a}`
function planeContacts(a: Particle, b: Particle): Contact[] {
  const n = rotate(b.rotation, { x: 0, y: 1, z: 0 }), offsets: Vec3[] = []
  if (a.spec.shape.kind === 'sphere') offsets.push(scale(n, -a.spec.shape.radius))
  else if (a.spec.shape.kind === 'box') {
    const h = a.spec.shape.half
    for (const x of [-h.x, h.x]) for (const y of [-h.y, h.y]) for (const z of [-h.z, h.z]) offsets.push(rotate(a.rotation, { x, y, z }))
  }
  return offsets.flatMap(ra => {
    const point = add(a.position, ra), depth = -dot(sub(point, b.position), n)
    return depth > -1e-7 ? [{ a, b, normal: n, ra, rb: sub(point, b.position), depth: Math.max(0, depth) }] : []
  })
}
function sphereBox(a: Particle, b: Particle): Contact[] {
  if (a.spec.shape.kind !== 'sphere' || b.spec.shape.kind !== 'box') return []
  const h = b.spec.shape.half, o = rotate(conjugate(b.rotation), sub(a.position, b.position))
  const closest = { x: clamp(o.x, -h.x, h.x), y: clamp(o.y, -h.y, h.y), z: clamp(o.z, -h.z, h.z) }
  let delta = sub(o, closest), distance = norm(delta)
  if (distance < 1e-10) {
    const keys = ['x', 'y', 'z'] as const
    const key = [...keys].sort((u, v) => h[u] - Math.abs(o[u]) - (h[v] - Math.abs(o[v])))[0]
    delta = { ...ZERO }; delta[key] = o[key] >= 0 ? 1 : -1
    distance = -(h[key] - Math.abs(o[key])); closest[key] = delta[key] * h[key]
  } else delta = scale(delta, 1 / distance)
  const depth = a.spec.shape.radius - distance
  if (depth < -1e-7) return []
  const normal = rotate(b.rotation, delta)
  return [{ a, b, normal, ra: scale(normal, -a.spec.shape.radius), rb: rotate(b.rotation, closest), depth: Math.max(0, depth) }]
}
function contacts(a: Particle, b: Particle): Contact[] {
  if (b.spec.shape.kind === 'plane') return planeContacts(a, b)
  if (a.spec.shape.kind === 'plane') return planeContacts(b, a)
  if (a.spec.shape.kind === 'sphere' && b.spec.shape.kind === 'box') return sphereBox(a, b)
  if (b.spec.shape.kind === 'sphere' && a.spec.shape.kind === 'box') return sphereBox(b, a)
  if (a.spec.shape.kind === 'sphere' && b.spec.shape.kind === 'sphere') {
    const delta = sub(a.position, b.position), d = norm(delta), depth = a.spec.shape.radius + b.spec.shape.radius - d
    if (depth < -1e-7) return []
    const n = d < 1e-10 ? AXES[0] : scale(delta, 1 / d)
    return [{ a, b, normal: n, ra: scale(n, -a.spec.shape.radius), rb: scale(n, b.spec.shape.radius), depth: Math.max(0, depth) }]
  }
  return []
}
export async function createCustomBackend(scene: Scene, _limits: Readonly<Limits>): Promise<Backend> {
  if (scene.contact) throw new RangeError('Custom backend does not support requested contact solver settings')
  const boxes = scene.bodies.filter(b => b.shape.kind === 'box')
  if (boxes.some(a => boxes.some(b => b.id !== a.id && (!a.fixed || !b.fixed)))) throw new Error('Unsupported custom box/box contacts')
  let disposed = false
  const bodies = new Map<string, Particle>(scene.bodies.map(b => [b.id, { id: b.id, spec: b, position: { ...b.position }, rotation: { ...b.rotation },
    velocity: { ...b.velocity }, angularVelocity: { ...b.angularVelocity }, sleeping: b.fixed,
    inverseMass: b.fixed ? 0 : 1 / b.mass, inverseInertia: inertia(b), force: { ...ZERO }, torque: { ...ZERO }, quiet: 0 }]))
  const list = [...bodies.values()], joined = new Set(scene.joints.map(j => pairKey(j.parent, j.child)))
  const get = (id: string) => { if (disposed) throw new Error('Custom backend disposed'); const b = bodies.get(id); if (!b) throw new RangeError('Unknown custom body'); return b }
  const allContacts = () => {
    const result: Contact[] = []
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      if ((!list[a].inverseMass && !list[b].inverseMass) || joined.has(pairKey(list[a].id, list[b].id))) continue
      result.push(...contacts(list[a], list[b]))
    }
    return result
  }
  return {
    id: 'custom', version: 'obpal-pbd-1',
    capabilities: { contacts: 'sphere/sphere, sphere/box and sphere-or-box/plane', articulation: 'position-based spherical tree',
      motor: 'bounded-torque', cones: 'compliant elliptical swing/twist stop', wheels: 'static-ray-suspension', buoyancy: 'sampled-displacement',
      unsupported: ['box/box contacts', 'compound or mesh colliders', 'CCD', 'native reduced coordinates', 'dynamic tyre terrain'] },
    read(id) { const b = get(id); return { id, position: { ...b.position }, rotation: { ...b.rotation }, velocity: { ...b.velocity }, angularVelocity: { ...b.angularVelocity }, sleeping: b.sleeping } },
    force(id, f, p) { const b = get(id); b.force = add(b.force, f); b.torque = add(b.torque, cross(sub(p, b.position), f)) },
    torque(id, t) { const b = get(id); b.torque = add(b.torque, t) },
    sleep(id, sleeping) { const b = get(id); if (!b.inverseMass) return; b.sleeping = sleeping; b.quiet = 0; if (sleeping) { b.velocity = { ...ZERO }; b.angularVelocity = { ...ZERO } } },
    step(outerDt) {
      // Four bounded microsteps reduce position-projection energy loss. Actuation is held for the outer 1/240 s tick.
      const dt = outerDt / 4
      for (let micro = 0; micro < 4; micro++) {
      if (disposed) throw new Error('Custom backend disposed')
      const previous = list.map(b => ({ p: { ...b.position }, q: { ...b.rotation } }))
      for (const b of list) {
        if (b.inverseMass && !b.sleeping) {
          b.velocity = scale(add(b.velocity, scale(add(scene.gravity, scale(b.force, b.inverseMass)), dt)), Math.exp(-b.spec.linearDamping * dt))
          b.angularVelocity = scale(add(b.angularVelocity, scale(invI(b, b.torque), dt)), Math.exp(-b.spec.angularDamping * dt))
          b.position = add(b.position, scale(b.velocity, dt))
          b.rotation = quaternion(multiply(fromRotationVector(scale(b.angularVelocity, dt)), b.rotation))
        }
      }
      const impact = new Map<string, number>()
      for (const c of allContacts()) {
        const key = pairKey(c.a.id, c.b.id)
        impact.set(key, Math.min(impact.get(key) ?? 0, dot(sub(velocityAt(c.a, c.ra), velocityAt(c.b, c.rb)), c.normal)))
      }
      // Count-limited Gauss-Seidel position projections. Compliance/motor overshoot remains observable.
      for (let iteration = 0; iteration < 12; iteration++) {
        for (const j of scene.joints) {
          const a = get(j.child), b = get(j.parent)
          if (a.sleeping && b.sleeping) continue
          for (const n of AXES) {
            const ra = rotate(a.rotation, j.anchorChild), rb = rotate(b.rotation, j.anchorParent)
            const error = dot(sub(add(a.position, ra), add(b.position, rb)), n), k = effective(a, ra, n) + effective(b, rb, n)
            if (k > 1e-10) { const p = scale(n, -.8 * error / k); shift(a, ra, p); shift(b, rb, scale(p, -1)) }
          }
        }
        for (const c of allContacts()) {
          const k = effective(c.a, c.ra, c.normal) + effective(c.b, c.rb, c.normal)
          if (k <= 1e-10 || c.depth <= 0) continue
          const p = scale(c.normal, .9 * c.depth / k)
          shift(c.a, c.ra, p); shift(c.b, c.rb, scale(p, -1))
        }
      }
      for (let n = 0; n < list.length; n++) {
        const b = list[n]
        if (b.inverseMass && !b.sleeping) {
          b.velocity = scale(sub(b.position, previous[n].p), 1 / dt)
          b.angularVelocity = scale(rotationVector(multiply(b.rotation, conjugate(previous[n].q))), 1 / dt)
        }
      }
      const supported = new Set<string>()
      for (const c of allContacts()) {
        supported.add(c.a.id); supported.add(c.b.id)
        const pre = impact.get(pairKey(c.a.id, c.b.id)) ?? 0, restitution = Math.min(c.a.spec.restitution, c.b.spec.restitution)
        const current = dot(sub(velocityAt(c.a, c.ra), velocityAt(c.b, c.rb)), c.normal)
        const k = effective(c.a, c.ra, c.normal) + effective(c.b, c.rb, c.normal)
        if (k < 1e-10) continue
        const target = pre < -.2 ? -pre * restitution : 0, impulse = Math.max(0, (target - current) / k)
        velocityImpulse(c.a, c.ra, scale(c.normal, impulse)); velocityImpulse(c.b, c.rb, scale(c.normal, -impulse))
        const v = sub(velocityAt(c.a, c.ra), velocityAt(c.b, c.rb)), tangent = sub(v, scale(c.normal, dot(v, c.normal))), speed = norm(tangent)
        if (speed > 1e-10) {
          const n = scale(tangent, 1 / speed), kt = effective(c.a, c.ra, n) + effective(c.b, c.rb, n)
          const normalImpulse = Math.max(impulse, -pre / k), friction = Math.sqrt(c.a.spec.friction * c.b.spec.friction)
          const p = scale(n, -Math.min(speed / kt, friction * normalImpulse))
          velocityImpulse(c.a, c.ra, p); velocityImpulse(c.b, c.rb, scale(p, -1))
        }
      }
      for (const b of list) if (b.inverseMass) {
        b.quiet = supported.has(b.id) && norm(b.velocity) < .02 && norm(b.angularVelocity) < .03 ? b.quiet + dt : 0
        if (b.quiet >= .5) { b.sleeping = true; b.velocity = { ...ZERO }; b.angularVelocity = { ...ZERO } }
      }
      }
      for (const b of list) { b.force = { ...ZERO }; b.torque = { ...ZERO } }
    },
    memoryBytes: () => null, // A JS heap estimate is not native allocation accounting.
    dispose() { if (disposed) return; disposed = true; bodies.clear(); list.length = 0 },
  }
}
