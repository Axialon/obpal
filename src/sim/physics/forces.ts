/** Identical finite suspension, buoyancy and bounded torque controls for the comparison fixtures. */
import { add, sub, scale, dot, cross, norm, unit, capped, rotate, conjugate, multiply, localPoint, rotationVector, clampCone, clamp, ZERO, type Vec3, type Quat } from './math'
import { dampedServo } from './servo'
import { coupledServo, type CoupledDiagnostics } from './coupled-servo'
import { STEP } from './schema'
import type { Backend, Body, BodyState, Scene, Limits, ContactSample } from './schema'
export interface Wrench { force: Vec3; torque: Vec3 }
export interface ForceDiagnostics { wheelLoads: Record<string, number>; displacedVolumes: Record<string, number>; motorTorques: Record<string, number>; coupled?: CoupledDiagnostics }
export function accumulate(out: Map<string, Wrench>, id: string, force: Vec3, torque: Vec3 = ZERO): void {
  const before = out.get(id) ?? { force: { ...ZERO }, torque: { ...ZERO } }
  out.set(id, { force: add(before.force, force), torque: add(before.torque, torque) })
}
const atPoint = (out: Map<string, Wrench>, body: BodyState, force: Vec3, at: Vec3) => accumulate(out, body.id, force, cross(sub(at, body.position), force))
const pointVelocity = (s: BodyState, p: Vec3) => add(s.velocity, cross(s.angularVelocity, sub(p, s.position)))

/** Static-collider ray cast shared by all candidates. Moving terrain/tyre deformation are explicitly unsupported. */
export function rayStatic(bodies: readonly Body[], origin: Vec3, direction: Vec3, distance: number) {
  let nearest: { distance: number; normal: Vec3 } | null = null
  for (const b of bodies) {
    if (!b.fixed) continue
    const o = rotate(conjugate(b.rotation), sub(origin, b.position)), d = rotate(conjugate(b.rotation), direction)
    let t = Infinity, normal = { ...ZERO }
    if (b.shape.kind === 'plane') {
      if (d.y < -1e-8 && o.y >= 0) { t = -o.y / d.y; normal = { x: 0, y: 1, z: 0 } }
    } else if (b.shape.kind === 'sphere') {
      const v = dot(o, d), disc = v * v - (dot(o, o) - b.shape.radius ** 2)
      if (disc >= 0) { t = -v - Math.sqrt(disc); normal = unit(add(o, scale(d, t))) }
    } else {
      let enter = -Infinity, exit = Infinity
      for (const k of ['x', 'y', 'z'] as const) {
        if (Math.abs(d[k]) < 1e-10) { if (Math.abs(o[k]) > b.shape.half[k]) { exit = -Infinity; break }; continue }
        let a = (-b.shape.half[k] - o[k]) / d[k], z = (b.shape.half[k] - o[k]) / d[k]
        if (a > z) [a, z] = [z, a]
        if (a > enter) { enter = a; normal = { ...ZERO }; normal[k] = d[k] < 0 ? 1 : -1 }
        exit = Math.min(exit, z)
      }
      if (enter <= exit) t = enter
    }
    if (t >= 0 && t <= distance && (!nearest || t < nearest.distance)) nearest = { distance: t, normal: rotate(b.rotation, normal) }
  }
  return nearest
}
export function actuatorForces(scene: Scene, backend: Backend, targets: ReadonlyMap<string, Quat>, limits: Readonly<Limits>, out: Map<string, Wrench>, contacts?: readonly ContactSample[]): ForceDiagnostics {
  const report: ForceDiagnostics = { wheelLoads: {}, displacedVolumes: {}, motorTorques: {} }
  const coupledMode = scene.joints.some(j => j.motor.integration === 'constraint-damped')
  if (coupledMode && (contacts === undefined || backend.capabilities.motor !== 'bounded-torque'))
    throw new Error('Constraint-damped motors require bounded torques and actual contact observations')
  const coupled = coupledMode ? coupledServo(scene, scene.bodies.map(b => backend.read(b.id)), targets, contacts!, STEP) : null
  if (coupled) report.coupled = { ...coupled.diagnostics }
  for (const j of scene.joints) {
    if (coupled) {
      const torque = coupled.torques.get(j.id)!
      report.motorTorques[j.id] = norm(torque)
      accumulate(out, j.child, ZERO, torque); accumulate(out, j.parent, ZERO, scale(torque, -1))
      continue // Motor + stop were solved once, together; never add a second explicit stop.
    }
    const parent = backend.read(j.parent), child = backend.read(j.child)
    const frame = multiply(parent.rotation, j.frameParent), relative = multiply(conjugate(frame), multiply(child.rotation, j.frameChild))
    const target = targets.get(j.id) ?? j.motor.target, velocity = sub(child.angularVelocity, parent.angularVelocity)
    const stop = rotationVector(multiply(clampCone(relative, j.cone), conjugate(relative)))
    let torque: Vec3 = { ...ZERO }
    if (backend.capabilities.motor === 'native-drive') backend.motor!(j.id, target)
    else {
      const error = rotate(frame, rotationVector(multiply(target, conjugate(relative))))
      torque = j.motor.integration === 'inertia-damped'
        ? dampedServo(scene.bodies.find(b => b.id === j.parent)!, parent, scene.bodies.find(b => b.id === j.child)!, child,
          error, velocity, j.motor.stiffness, j.motor.damping, j.motor.maxTorque, STEP, rotate(frame, stop))
        : capped(sub(capped(scale(error, j.motor.stiffness), j.motor.maxTorque), scale(velocity, j.motor.damping)), j.motor.maxTorque)
    }
    report.motorTorques[j.id] = norm(torque)
    // A finite, compliant elliptical stop; overshoot is measured, never silently projected in the WASM backends.
    if (j.motor.integration !== 'inertia-damped' && norm(stop) > 1e-8) {
      const correction = rotate(frame, stop), n = unit(correction)
      const stopTorque = capped(add(scale(correction, 1200), scale(n, Math.max(0, -dot(velocity, n)) * 30)), limits.maxTorque)
      torque = add(torque, stopTorque)
    }
    if (j.motor.integration === 'inertia-damped') report.motorTorques[j.id] = norm(torque)
    accumulate(out, child.id, ZERO, torque); accumulate(out, parent.id, ZERO, scale(torque, -1))
  }
  for (const w of scene.wheels) {
    const s = backend.read(w.body), mount = localPoint(s.position, s.rotation, w.point)
    const down = rotate(s.rotation, { x: 0, y: -1, z: 0 }), hit = rayStatic(scene.bodies, mount, down, w.restLength + w.radius)
    report.wheelLoads[w.id] = 0
    if (!hit) continue
    const compression = clamp(w.restLength + w.radius - hit.distance, 0, w.restLength)
    const contact = add(mount, scale(down, hit.distance)), velocity = pointVelocity(s, contact)
    const load = clamp(w.stiffness * compression - w.damping * dot(velocity, hit.normal), 0, w.maxForce)
    report.wheelLoads[w.id] = load
    const heading = rotate(s.rotation, { x: 0, y: 0, z: 1 }), forward = unit(sub(heading, scale(hit.normal, dot(heading, hit.normal))))
    const lateral = unit(cross(hit.normal, forward))
    const traction = capped(add(scale(forward, w.driveForce - dot(velocity, forward) * .6),
      scale(lateral, -dot(velocity, lateral) * w.damping)), w.friction * load)
    atPoint(out, s, add(scale(hit.normal, load), traction), contact)
  }
  for (const b of scene.buoys) {
    const s = backend.read(b.body); let displaced = 0
    for (const sample of b.samples) {
      const p = localPoint(s.position, s.rotation, sample.point), r = sample.radius
      const h = clamp(b.height - p.y + r, 0, 2 * r), fraction = h * h * (3 * r - h) / (4 * r ** 3)
      const volume = sample.volume * fraction; displaced += volume
      const lift = { x: 0, y: b.density * -scene.gravity.y * volume, z: 0 }
      const drag = scale(pointVelocity(s, p), -b.drag * fraction)
      atPoint(out, s, capped(add(lift, drag), limits.maxForce), p)
    }
    report.displacedVolumes[b.id] = displaced
  }
  return report
}
