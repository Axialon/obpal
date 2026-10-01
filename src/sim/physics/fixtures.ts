/** One fixture definition and metric path for every engine, in Node and in the browser. No predetermined results. */
import { fixtureFailures } from './fixture-validation'
import { Simulation } from './runtime'
import { STEP, type BackendFactory, type Body, type BodyState, type SceneInput, type Scene, type Capabilities } from './schema'
import { IDENTITY, ZERO, sub, dot, norm, rotate, conjugate, multiply, fromRotationVector, localPoint, angleBetween, clampCone } from './math'
export const FIXTURE_NAMES = ['drop', 'motor-chain', 'saturated-cone', 'wheels', 'buoyancy', 'energy', 'damping'] as const
export type FixtureName = typeof FIXTURE_NAMES[number]
const ground = (y = 0) => ({ id: 'ground', fixed: true, shape: { kind: 'plane' as const }, position: { x: 0, y, z: 0 }, friction: .6, restitution: .1 })
const ball = (id: string, y: number) => ({ id, shape: { kind: 'sphere' as const, radius: .25 }, position: { x: 0, y, z: 0 }, mass: 1, restitution: .1 })
export function fixture(name: FixtureName): { scene: SceneInput; steps: number } {
  if (name === 'drop') return { scene: { bodies: [ground(), ball('ball', 2)] }, steps: 960 }
  if (name === 'motor-chain' || name === 'saturated-cone') {
    const target = name === 'motor-chain' ? fromRotationVector({ x: .18, y: .12, z: .1 }) : fromRotationVector({ x: 2, y: 2, z: -2 })
    return { scene: { bodies: [ground(), { ...ball('root', 3), fixed: true }, ball('link1', 2.3), ball('link2', 1.6)],
      joints: ['link1', 'link2'].map((child, n) => ({ id: `joint${n + 1}`, parent: n ? 'link1' : 'root', child,
        anchorParent: { x: 0, y: -.35, z: 0 }, anchorChild: { x: 0, y: .35, z: 0 },
        cone: { swingY: .4, swingZ: .4, twistMin: -.35, twistMax: .35 },
        motor: { target, stiffness: 60, damping: 4, maxTorque: name === 'saturated-cone' ? 2.5 : 20 } })) }, steps: 1920 }
  }
  if (name === 'wheels') return { scene: { bodies: [ground(), { id: 'chassis', shape: { kind: 'box', half: { x: .4, y: .15, z: .6 } }, mass: 10, position: { x: 0, y: .8, z: 0 } }],
    wheels: [-1, 1].flatMap((x, n) => [-1, 1].map((z, m) => ({ id: `wheel${n}${m}`, body: 'chassis', point: { x: .35 * x, y: 0, z: .45 * z },
      radius: .2, restLength: .5, stiffness: 400, damping: 35, friction: .8, maxForce: 300, driveForce: 5 }))) }, steps: 1440 }
  if (name === 'buoyancy') return { scene: { bodies: [ground(-5), { id: 'hull', shape: { kind: 'box', half: { x: .4, y: .15, z: .3 } },
    mass: 3, position: { x: 0, y: 1.4, z: 0 }, rotation: fromRotationVector({ x: .08, y: 0, z: .08 }) }],
    buoys: [{ id: 'water', body: 'hull', height: 1, density: 1000, drag: 8,
      samples: [-1, 1].flatMap(x => [-1, 1].map(z => ({ point: { x: .25 * x, y: 0, z: .2 * z }, radius: .25, volume: .0015 }))) }] }, steps: 1920 }
  if (name === 'energy') {
    const rotation = fromRotationVector({ x: 0, y: 0, z: .5 }), position = sub({ x: 0, y: 3, z: 0 }, rotate(rotation, { x: 0, y: .35, z: 0 }))
    return { scene: { bodies: [{ ...ball('root', 3), fixed: true, shape: { kind: 'sphere', radius: .1 } }, { ...ball('bob', 0), position, rotation }],
      joints: [{ id: 'free-joint', parent: 'root', child: 'bob', anchorParent: { ...ZERO }, anchorChild: { x: 0, y: .35, z: 0 },
        cone: { swingY: 2, swingZ: 2, twistMin: -2, twistMax: 2 }, motor: { target: { ...IDENTITY }, stiffness: 0, damping: 0, maxTorque: 0 } }] }, steps: 1200 }
  }
  return { scene: { gravity: { ...ZERO }, bodies: [{ ...ball('spin', 1), angularVelocity: { x: 0, y: 0, z: 1 }, angularDamping: .7 }] }, steps: 720 }
}
export function bodyEnergy(spec: Body, s: BodyState, gravity: number, baseHeight = 0): number {
  const w = rotate(conjugate(s.rotation), s.angularVelocity)
  let rotational = 0
  if (spec.shape.kind === 'sphere') rotational = .2 * spec.mass * spec.shape.radius ** 2 * dot(w, w)
  if (spec.shape.kind === 'box') { const h = spec.shape.half; rotational = spec.mass / 6 * ((h.y ** 2 + h.z ** 2) * w.x ** 2 + (h.x ** 2 + h.z ** 2) * w.y ** 2 + (h.x ** 2 + h.y ** 2) * w.z ** 2) }
  return .5 * spec.mass * dot(s.velocity, s.velocity) + rotational + spec.mass * gravity * (s.position.y - baseHeight)
}
export function penetration(scene: Scene, state: BodyState[]): number {
  let maximum = 0
  for (const b of scene.bodies.filter(b => !b.fixed)) {
    const s = state.find(s => s.id === b.id)!
    for (const p of scene.bodies.filter(b => b.shape.kind === 'plane')) {
      const normal = rotate(p.rotation, { x: 0, y: 1, z: 0 })
      let support = 0
      if (b.shape.kind === 'sphere') support = b.shape.radius
      if (b.shape.kind === 'box') { const n = rotate(conjugate(s.rotation), normal), h = b.shape.half; support = Math.abs(n.x) * h.x + Math.abs(n.y) * h.y + Math.abs(n.z) * h.z }
      maximum = Math.max(maximum, support - dot(sub(s.position, p.position), normal))
    }
  }
  return maximum
}
export function jointMetrics(scene: Scene, state: BodyState[]) {
  let constraint = 0, cone = 0, targetError = 0, speed = 0
  for (const j of scene.joints) {
    const a = state.find(b => b.id === j.parent)!, b = state.find(b => b.id === j.child)!
    constraint = Math.max(constraint, norm(sub(localPoint(a.position, a.rotation, j.anchorParent), localPoint(b.position, b.rotation, j.anchorChild))))
    const relative = multiply(conjugate(multiply(a.rotation, j.frameParent)), multiply(b.rotation, j.frameChild))
    cone = Math.max(cone, angleBetween(relative, clampCone(relative, j.cone)))
    targetError = Math.max(targetError, angleBetween(relative, j.motor.target)); speed = Math.max(speed, norm(sub(a.angularVelocity, b.angularVelocity)))
  }
  return { constraint, cone, targetError, speed }
}
export interface FixtureResult {
  fixture: FixtureName; status: 'measured' | 'blocked'; blocker: string | null; failures: string[]
  initMs: number | null; cpuMs: { p50: number; p95: number; p99: number; samples: number; zeroSamples: number }
  metrics: Record<string, number | null>; trajectory: BodyState[][]; capabilities: Capabilities | null; version: string | null; memoryBytes: number | null
}
export const percentile = (sorted: readonly number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : 0
export async function measureFixture(factory: BackendFactory, name: FixtureName): Promise<FixtureResult> {
  const spec = fixture(name), simulation = new Simulation(spec.scene, factory), scene = simulation.scene
  const result: FixtureResult = { fixture: name, status: 'blocked', blocker: null, failures: [], initMs: null,
    cpuMs: { p50: 0, p95: 0, p99: 0, samples: 0, zeroSamples: 0 }, metrics: {}, trajectory: [], capabilities: null, version: null, memoryBytes: null }
  const times: number[] = []; let maxPenetration = 0, maxConstraint = 0, maxCone = 0, maxDrift = 0, maxEnergyRise = 0
  let settledFor = 0, settledAt: number | null = null, loadSum = 0, volumeSum = 0, tail = 0, peakTorque = 0
  try {
    const start = performance.now(); await simulation.init(); result.initMs = performance.now() - start
    const metadata = simulation.metadata(); result.capabilities = metadata.capabilities; result.version = metadata.version
    const first = simulation.snapshot(), moving = scene.bodies.find(b => !b.fixed)!
    const energy = (states: BodyState[]) => bodyEnergy(moving, states.find(b => b.id === moving.id)!, -scene.gravity.y, name === 'energy' ? 2.65 : 0)
    const initialEnergy = energy(first); let lastEnergy = initialEnergy
    for (let n = 0; n < spec.steps; n++) {
      const before = performance.now(); simulation.advance(STEP); times.push(performance.now() - before)
      const states = simulation.snapshot(), joints = jointMetrics(scene, states), diagnostics = simulation.diagnostics()
      maxPenetration = Math.max(maxPenetration, penetration(scene, states)); maxConstraint = Math.max(maxConstraint, joints.constraint); maxCone = Math.max(maxCone, joints.cone)
      if (joints.targetError < .07 && joints.speed < .1) { settledFor += STEP; if (settledFor >= .5 && settledAt === null) settledAt = Math.max(0, (n + 1) * STEP - .5) }
      else { settledFor = 0; settledAt = null }
      if (name === 'energy') maxDrift = Math.max(maxDrift, Math.abs(energy(states) / initialEnergy - 1))
      if (name === 'damping') { const now = energy(states); maxEnergyRise = Math.max(maxEnergyRise, now - lastEnergy); lastEnergy = now }
      peakTorque = Math.max(peakTorque, ...Object.values(diagnostics.forces.motorTorques))
      if (n >= spec.steps - 240) { loadSum += Object.values(diagnostics.forces.wheelLoads).reduce((a, b) => a + b, 0); volumeSum += Object.values(diagnostics.forces.displacedVolumes).reduce((a, b) => a + b, 0); tail++ }
      if (n % 24 === 0 || n === spec.steps - 1) result.trajectory.push(states)
    }
    const states = simulation.snapshot(), final = states.find(s => s.id === moving.id)!, joints = jointMetrics(scene, states)
    result.memoryBytes = simulation.metadata().memoryBytes
    result.metrics = { simulatedSeconds: spec.steps * STEP, penetrationM: maxPenetration, constraintErrorM: maxConstraint, peakConeErrorRad: maxCone,
      finalConeErrorRad: joints.cone, targetErrorRad: scene.joints.length ? joints.targetError : null,
      motorSettlingSeconds: scene.joints.length && name !== 'energy' ? settledAt : null,
      peakMotorTorqueNm: scene.joints.length ? peakTorque : null,
      rollingLoadN: name === 'wheels' ? loadSum / tail : null, rollingDistanceM: name === 'wheels' ? final.position.z : null,
      floatingTrimM: name === 'buoyancy' ? final.position.y - 1 : null, displacedVolumeM3: name === 'buoyancy' ? volumeSum / tail : null,
      energyDriftRelative: name === 'energy' ? maxDrift : null, dampingRatio: name === 'damping' ? energy(states) / initialEnergy : null,
      dampingExpectedRatio: name === 'damping' ? Math.exp(-2 * moving.angularDamping * spec.steps * STEP) : null,
      energyRiseJ: name === 'damping' ? maxEnergyRise : null, finalRelativeAngularSpeedRadps: joints.speed, finalSpeedMps: norm(final.velocity), finalAngularSpeedRadps: norm(final.angularVelocity), finalY: final.position.y }
    result.failures.push(...fixtureFailures(name, result.metrics))
    result.status = 'measured'
  } catch (error) { result.blocker = error instanceof Error ? error.message : String(error); result.failures.push('fixture blocked; not a passing assertion') }
  finally { try { simulation.dispose() } catch (e) { result.failures.push(`disposal failed: ${String(e)}`) } }
  times.sort((a, b) => a - b)
  result.cpuMs = { p50: percentile(times, .5), p95: percentile(times, .95), p99: percentile(times, .99), samples: times.length, zeroSamples: times.filter(t => t === 0).length }
  return result
}
/** Same engine/runtime only. Compare every sampled transform and velocity, allowing quaternion sign equivalence. */
export function repeatability(a: BodyState[][], b: BodyState[][]): number | null {
  if (a.length !== b.length || !a.length) return null
  let error = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return null
    for (let j = 0; j < a[i].length; j++) {
      const x = a[i][j], y = b[i][j]
      if (x.id !== y.id || x.sleeping !== y.sleeping) return null
      error = Math.max(error, norm(sub(x.position, y.position)), norm(sub(x.velocity, y.velocity)), norm(sub(x.angularVelocity, y.angularVelocity)), angleBetween(x.rotation, y.rotation))
    }
  }
  return error
}
