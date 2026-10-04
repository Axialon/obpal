/** Validated scene input. No framework, renderer, transport or hardware dependency. */
import { IDENTITY, ZERO, norm, quaternion, clampCone, type Cone, type Quat, type Vec3 } from './math'
export type { Cone, Quat, Vec3 } from './math'
export type EngineId = 'custom' | 'rapier' | 'physx'
export type Shape = { kind: 'sphere'; radius: number } | { kind: 'box'; half: Vec3 } | { kind: 'plane' }
export interface BodyInput {
  id: string; shape: Shape; position: Vec3; rotation?: Quat; fixed?: boolean; mass?: number
  velocity?: Vec3; angularVelocity?: Vec3; friction?: number; restitution?: number; linearDamping?: number; angularDamping?: number
}
export interface Body extends BodyInput {
  rotation: Quat; fixed: boolean; mass: number; velocity: Vec3; angularVelocity: Vec3
  friction: number; restitution: number; linearDamping: number; angularDamping: number
}
export interface Motor { integration?: 'inertia-damped' | 'constraint-damped'; target: Quat; stiffness: number; damping: number; maxTorque: number }
export interface JointInput { id: string; parent: string; child: string; anchorParent: Vec3; anchorChild: Vec3; frameParent?: Quat; frameChild?: Quat; cone: Cone; motor: Motor }
export interface Joint extends JointInput { frameParent: Quat; frameChild: Quat }
export interface Wheel {
  id: string; body: string; point: Vec3; radius: number; restLength: number; stiffness: number; damping: number
  friction: number; maxForce: number; driveForce: number
}
export interface Buoy {
  id: string; body: string; height: number; density: number; drag: number
  samples: { point: Vec3; radius: number; volume: number }[]
}
export interface ContactSettings { solverIterations: number; allowedLinearError: number; predictionDistance: number }
/** Owned narrow-phase sample. normalOnB points from A to B; points are world-space, impulse is N s. */
export interface ContactSample { a: string; b: string; pointA: Vec3; pointB: Vec3; normalOnB: Vec3; distance: number; impulse: number }
export interface SceneInput { contact?: ContactSettings; bodies: BodyInput[]; gravity?: Vec3; joints?: JointInput[]; wheels?: Wheel[]; buoys?: Buoy[] }
export interface Scene { contact?: ContactSettings; bodies: Body[]; gravity: Vec3; joints: Joint[]; wheels: Wheel[]; buoys: Buoy[] }
export interface Limits { maxBodies: number; maxJoints: number; maxForces: number; maxForce: number; maxTorque: number; maxSteps: number; maxFrame: number; maxSpeed: number; maxAngularSpeed: number; maxPosition: number }
export const STEP = 1 / 240
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({ maxBodies: 64, maxJoints: 63, maxForces: 128,
  maxForce: 20000, maxTorque: 2000, maxSteps: 12, maxFrame: .05, maxSpeed: 100, maxAngularSpeed: 100, maxPosition: 10000 })
export interface BodyState { id: string; position: Vec3; rotation: Quat; velocity: Vec3; angularVelocity: Vec3; sleeping: boolean }
export interface Capabilities {
  contacts: string; articulation: string; motor: 'bounded-torque' | 'native-drive'; cones: string
  wheels: 'static-ray-suspension'; buoyancy: 'sampled-displacement'; unsupported: string[]
}
/** Private engines own native resources. Callers only see owned values and scene identifiers. */
export interface Backend {
  id: EngineId; version: string; capabilities: Capabilities
  read(id: string): BodyState
  force(id: string, force: Vec3, at: Vec3): void
  torque(id: string, torque: Vec3): void
  step(dt: number): void
  sleep(id: string, sleeping: boolean): void
  motor?(id: string, target: Quat): void
  contacts?(): ContactSample[]
  memoryBytes(): number | null
  dispose(): void
}
export type BackendFactory = (scene: Scene, limits: Readonly<Limits>) => Promise<Backend>
export function numberIn(value: number, lo: number, hi: number, label: string): number {
  if (!Number.isFinite(value) || value < lo || value > hi) throw new RangeError(`Invalid ${label}`)
  return value
}
export function vector(value: Vec3, limit: number, label: string): Vec3 {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite) || norm(value) > limit) throw new RangeError(`Invalid ${label}`)
  return { x: value.x, y: value.y, z: value.z }
}
export function validateLimits(input: Partial<Limits> = {}): Readonly<Limits> {
  const out = { ...DEFAULT_LIMITS, ...input }
  for (const key of ['maxBodies', 'maxJoints', 'maxForces', 'maxSteps'] as const) {
    if (!Number.isInteger(out[key])) throw new RangeError(`Invalid ${key}`)
    numberIn(out[key], 1, DEFAULT_LIMITS[key], key)
  }
  for (const key of ['maxForce', 'maxTorque', 'maxFrame', 'maxSpeed', 'maxAngularSpeed', 'maxPosition'] as const)
    numberIn(out[key], key === 'maxFrame' ? STEP : .001, DEFAULT_LIMITS[key], key)
  return Object.freeze(out)
}
function identifier(id: string, used?: Set<string>) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(id) || used?.has(id)) throw new RangeError('Invalid or duplicate physics identifier')
  used?.add(id); return id
}
export function validateScene(input: SceneInput, budget: Partial<Limits> = {}): Scene {
  const limits = validateLimits(budget), ids = new Set<string>()
  if (!input || !Array.isArray(input.bodies) || input.bodies.length > limits.maxBodies) throw new RangeError('Physics body budget exceeded')
  const bodies: Body[] = input.bodies.map(b => {
    identifier(b.id, ids)
    const fixed = b.fixed ?? false
    if (typeof fixed !== 'boolean') throw new RangeError('Invalid fixed flag')
    let shape: Shape
    if (b.shape?.kind === 'sphere') shape = { kind: 'sphere', radius: numberIn(b.shape.radius, .01, 100, 'radius') }
    else if (b.shape?.kind === 'box') {
      const h = vector(b.shape.half, 175, 'box half extents')
      for (const v of Object.values(h)) numberIn(v, .01, 100, 'box half extent')
      shape = { kind: 'box', half: h }
    } else if (b.shape?.kind === 'plane' && fixed) shape = { kind: 'plane' }
    else throw new RangeError('Unsupported shape or dynamic plane')
    return { id: b.id, fixed, shape, position: vector(b.position, limits.maxPosition, 'position'),
      rotation: quaternion(b.rotation ?? IDENTITY), mass: numberIn(b.mass ?? 1, .01, 10000, 'mass'),
      velocity: vector(b.velocity ?? ZERO, limits.maxSpeed, 'velocity'), angularVelocity: vector(b.angularVelocity ?? ZERO, limits.maxAngularSpeed, 'angular velocity'),
      friction: numberIn(b.friction ?? .45, 0, 2, 'friction'), restitution: numberIn(b.restitution ?? .15, 0, 1, 'restitution'),
      linearDamping: numberIn(b.linearDamping ?? 0, 0, 20, 'linear damping'), angularDamping: numberIn(b.angularDamping ?? 0, 0, 20, 'angular damping') }
  })
  const byId = new Map(bodies.map(b => [b.id, b])), used = new Set(ids), parents = new Map<string, string>()
  const jointInputs = input.joints ?? []
  if (!Array.isArray(jointInputs) || jointInputs.length > limits.maxJoints) throw new RangeError('Physics joint budget exceeded')
  const joints = jointInputs.map(j => {
    identifier(j.id, used)
    if (!byId.has(j.parent) || !byId.has(j.child) || j.parent === j.child || byId.get(j.child)!.fixed || parents.has(j.child)) throw new RangeError('Invalid articulation tree')
    parents.set(j.child, j.parent)
    if (j.motor.integration !== undefined && j.motor.integration !== 'inertia-damped' && j.motor.integration !== 'constraint-damped') throw new RangeError('Invalid motor integration')
    const c = j.cone
    numberIn(c.swingY, .001, Math.PI - .01, 'swing Y'); numberIn(c.swingZ, .001, Math.PI - .01, 'swing Z')
    if (c.swingYMin !== undefined) numberIn(c.swingYMin, -Math.PI + .01, -.001, 'negative swing Y')
    if (c.swingZMin !== undefined) numberIn(c.swingZMin, -Math.PI + .01, -.001, 'negative swing Z')
    numberIn(c.twistMin, -Math.PI + .01, 0, 'twist minimum'); numberIn(c.twistMax, 0, Math.PI - .01, 'twist maximum')
    if (c.twistMax - c.twistMin < .001) throw new RangeError('Twist interval must have positive width')
    return { id: j.id, parent: j.parent, child: j.child, anchorParent: vector(j.anchorParent, 100, 'parent anchor'), anchorChild: vector(j.anchorChild, 100, 'child anchor'),
      frameParent: quaternion(j.frameParent ?? IDENTITY), frameChild: quaternion(j.frameChild ?? IDENTITY), cone: { ...c },
      motor: { ...(j.motor.integration ? { integration: j.motor.integration } : {}), target: clampCone(quaternion(j.motor.target), c), stiffness: numberIn(j.motor.stiffness, 0, 2000, 'motor stiffness'),
        damping: numberIn(j.motor.damping, 0, 200, 'motor damping'), maxTorque: numberIn(j.motor.maxTorque, 0, limits.maxTorque, 'motor torque') } }
  })
  if (joints.some(j => j.motor.integration === 'constraint-damped')) {
    if (joints.some(j => j.motor.integration !== 'constraint-damped')) throw new RangeError('Mixed coupled motor integration')
    if (joints.length > 32 || bodies.filter(b => !b.fixed).length > 32) throw new RangeError('Coupled response workspace exceeded')
    if (joints.some(j => j.motor.stiffness === 0 && j.motor.damping === 0)) throw new RangeError('Coupled servo requires positive impedance')
  }
  for (const id of parents.keys()) {
    const seen = new Set<string>(); let p: string | undefined = id
    while (p !== undefined) { if (seen.has(p)) throw new RangeError('Articulation cycle'); seen.add(p); p = parents.get(p) }
  }
  const wheelInputs = input.wheels ?? [], buoyInputs = input.buoys ?? []
  if (!Array.isArray(wheelInputs) || wheelInputs.length * 2 > limits.maxForces || !Array.isArray(buoyInputs) || buoyInputs.length > limits.maxForces) throw new RangeError('Actuator count budget exceeded')
  const wheels = wheelInputs.map(w => {
    identifier(w.id, used)
    if (!byId.has(w.body) || byId.get(w.body)!.fixed) throw new RangeError('Invalid wheel body')
    return { id: w.id, body: w.body, point: vector(w.point, 100, 'wheel point'), radius: numberIn(w.radius, .01, 10, 'wheel radius'),
      restLength: numberIn(w.restLength, .01, 10, 'suspension length'), stiffness: numberIn(w.stiffness, .01, 20000, 'spring'),
      damping: numberIn(w.damping, 0, 2000, 'suspension damping'), friction: numberIn(w.friction, 0, 2, 'tyre friction'),
      maxForce: numberIn(w.maxForce, .01, limits.maxForce, 'suspension force'), driveForce: numberIn(w.driveForce, -limits.maxForce, limits.maxForce, 'drive force') }
  })
  const buoys = buoyInputs.map(b => {
    identifier(b.id, used)
    if (!byId.has(b.body) || byId.get(b.body)!.fixed || !Array.isArray(b.samples) || !b.samples.length || b.samples.length > 16) throw new RangeError('Invalid buoy body or samples')
    return { id: b.id, body: b.body, height: numberIn(b.height, -1000, 1000, 'water height'), density: numberIn(b.density, .01, 20000, 'fluid density'),
      drag: numberIn(b.drag, 0, 2000, 'fluid drag'), samples: b.samples.map(p => ({ point: vector(p.point, 100, 'buoy sample'),
        radius: numberIn(p.radius, .001, 100, 'sample radius'), volume: numberIn(p.volume, .000001, 10, 'sample volume') })) }
  })
  // Reserve internal work before allocating native resources, not after a partial step.
  const actuatorForces = joints.length * 2 + wheels.length * 2 + buoys.reduce((n, b) => n + b.samples.length, 0)
  if (actuatorForces > limits.maxForces) throw new RangeError('Actuator force budget exceeded')
  const gravity = vector(input.gravity ?? { x: 0, y: -9.81, z: 0 }, 100, 'gravity')
  if (buoys.length && (gravity.x !== 0 || gravity.z !== 0 || gravity.y >= 0)) throw new RangeError('Buoyancy requires vertical downward gravity')
  let contact: ContactSettings | undefined
  if (input.contact !== undefined) {
    const c = input.contact
    if (!c || !Number.isInteger(c.solverIterations)) throw new RangeError('Invalid contact solver iterations')
    contact = { solverIterations: numberIn(c.solverIterations, 1, 32, 'contact solver iterations'),
      allowedLinearError: numberIn(c.allowedLinearError, .00001, .005, 'contact error'),
      predictionDistance: numberIn(c.predictionDistance, .00001, .01, 'contact prediction') }
  }
  return { bodies, gravity, joints, wheels, buoys, ...(contact ? { contact } : {}) }
}
