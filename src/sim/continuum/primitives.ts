/** Reduced biological primitives. Published constraints and designer parameters are distinguished in docs/OCTOPUS.md. */
import { Vector3 } from 'three'
import { bounded, clamp, finite, straight, type ContinuumArm, type Shape } from './profile'

export interface BendSettings {
  length: number
  radius: number
  mass: number
  density: number
  drag: number
  force: number
  withdrawal: number
}

/** Gutfreund 1998 cone and fitted drag. 0.108 N is our selected initial muscle force, not a measured active-reach force. */
export const REFERENCE_BEND: BendSettings = {
  length: 0.26, radius: 0.0085, mass: 0.025, density: 1000, drag: 0.313, force: 0.108, withdrawal: 0.7,
}

/** The distal arm moves at twice bend speed. F = d(2 m(x) v)/dt includes the mass-transfer term. */
export class BendDynamics {
  position = 0
  velocity = 0
  private area: number
  constructor(readonly settings: BendSettings = REFERENCE_BEND) {
    if (!Object.values(settings).every((n) => Number.isFinite(n) && n > 0) || settings.withdrawal >= 1)
      throw new Error('Invalid bend dynamics')
    this.area = Math.PI * settings.radius * Math.hypot(settings.length, settings.radius)
  }
  acceleration(position: number, velocity: number) {
    const p = this.settings,
      taper = Math.max(0.02, 1 - position / p.length),
      mass = p.mass * taper ** 3,
      derivative = (-3 * p.mass * taper ** 2) / p.length,
      muscle = position / p.length < p.withdrawal ? p.force * taper ** 2 : 0,
      // The paper fits Cd using bend speed in Eq. 3; the factor of two belongs to momentum, not this drag convention.
      drag = 0.5 * p.density * p.drag * this.area * taper ** 2 * velocity ** 2
    return (muscle - drag - 2 * derivative * velocity ** 2) / (2 * mass)
  }
  /** Midpoint integration of momentum; no prescribed endpoint/time or pose easing. */
  step(dt: number) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 1 / 30) return
    // The terminal force switch needs finer resolution than the much slower routed elastic state.
    const steps = Math.ceil(dt * 960),
      h = dt / steps
    for (let i = 0; i < steps; i++) {
      const acceleration = this.acceleration(this.position, this.velocity),
        midVelocity = Math.max(0, this.velocity + acceleration * h / 2),
        midPosition = this.position + this.velocity * h / 2
      this.position = Math.min(this.settings.length * 0.98, this.position + midVelocity * h)
      this.velocity = Math.max(0, this.velocity + this.acceleration(midPosition, midVelocity) * h)
      if (this.position >= this.settings.length * 0.98) this.velocity = 0
    }
  }
}

/** Activation peaks 75 ms before a bend; onset at three widths is 300 ms before it (Gutfreund 1998). */
export function stiffening(timeBeforeBend: number) {
  const offset = timeBeforeBend - 0.075
  return Math.abs(offset) <= 0.225 ? Math.exp(-0.5 * (offset / 0.075) ** 2) : 0
}

export class ReachPrimitive {
  readonly shapes: Shape[]
  readonly activation: number[]
  position = 0
  velocity = 0
  readonly dynamics: BendDynamics
  private elapsed = 0
  private arrival: number[]
  private centres: number[]
  constructor(readonly arm: ContinuumArm, readonly effort = 1, readonly plane = 0) {
    if (!(effort > 0) || effort > 4 || !Number.isFinite(effort)) throw new Error('Invalid reaching effort')
    this.shapes = arm.sections.map(straight)
    this.activation = arm.sections.map(() => 0)
    const length = arm.sections.reduce((sum, section) => sum + section.length, 0)
    let distance = 0
    this.centres = arm.sections.map((section) => {
      const centre = (distance + section.length / 2) / length
      distance += section.length
      return centre
    })
    // Normalize the study's reference arm into material coordinates. Its fitted Cd is not a Cove material measurement.
    const settings = { ...REFERENCE_BEND, force: REFERENCE_BEND.force * effort }
    this.dynamics = new BendDynamics(settings)
    this.arrival = arm.sections.map(() => Infinity)
    // With quadratic drag, force scaling changes time by 1/sqrt(effort). Preview at unit effort so slow reaches keep their stiffness wave.
    const preview = new BendDynamics(),
      h = 1 / 1200,
      timeScale = 1 / Math.sqrt(effort)
    for (let i = 0; i < 4 / h; i++) {
      preview.step(h)
      for (let j = 0; j < this.arrival.length; j++)
        if (this.arrival[j] === Infinity && preview.position / settings.length >= this.centres[j])
          this.arrival[j] = (i + 1) * h * timeScale
    }
  }
  step(dt: number) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 1 / 30) return this.shapes
    this.dynamics.step(dt)
    this.position = this.dynamics.position / this.dynamics.settings.length
    this.velocity = this.dynamics.velocity / this.dynamics.settings.length
    this.elapsed += dt
    for (let i = 0; i < this.shapes.length; i++) {
      const material = this.centres[i],
        section = this.arm.sections[i],
        packet = Math.exp(-0.5 * ((material - this.position) / 0.14) ** 2),
        curvature = (section.bend * 0.85 * packet) / section.length,
        shape = this.shapes[i]
      shape.kx = Math.cos(this.plane) * curvature
      shape.ky = Math.sin(this.plane) * curvature
      shape.strain = 0.1 * (1 - packet)
      shape.twist = 0
      bounded(section, shape, shape)
      this.activation[i] = stiffening(this.arrival[i] - this.elapsed)
    }
    return this.shapes
  }
  /** Restart excitation without redoing the load-time preview or clearing the separate tendon layer's momentum. */
  reset() {
    this.elapsed = this.position = this.velocity = 0
    this.dynamics.position = this.dynamics.velocity = 0
    this.activation.fill(0)
    for (const shape of this.shapes) Object.assign(shape, straight())
  }
}

/** The equal load-bearing segments straddle the elbow. The paper calls them proximal/medial; distal is the grasping hand. */
export function fetchSegments(grip: number) {
  const held = clamp(finite(grip, 0.8), 0.25, 0.95)
  return { proximal: held / 2, medial: held / 2, hand: 1 - held, elbow: held / 2, grip: held }
}

/** A transient elbow lies halfway to the grip; skin deformation still passes through routed elasticity. */
export function fetchShapes(arm: ContinuumArm, grip: number, curl: number, out = arm.sections.map(straight)) {
  const segments = fetchSegments(grip),
    amount = clamp(finite(curl), 0, 1),
    length = arm.sections.reduce((sum, section) => sum + section.length, 0)
  let distance = 0
  for (let i = 0; i < arm.sections.length; i++) {
    const section = arm.sections[i],
      s = (distance + section.length / 2) / length,
      elbow = Math.exp(-0.5 * ((s - segments.elbow) / 0.1) ** 2),
      hand = Math.exp(-0.5 * ((s - segments.grip) / 0.08) ** 2),
      base = Math.exp(-0.5 * ((s - 0.04) / 0.1) ** 2)
    Object.assign(out[i], { kx: ((elbow - 0.5 * hand - 0.5 * base) * amount * section.bend) / section.length, ky: 0, strain: 0, twist: 0 })
    bounded(section, out[i], out[i])
    distance += section.length
  }
  return out
}

export interface CrawlArm {
  id: string
  direction: Vector3
  attached: boolean
  strain: number
  capacity: number
}

/** Direction and current support recruit pushing arms. There is no oscillator, fixed arm order or walking animation. */
export function recruitCrawl(arms: readonly CrawlArm[], direction: Vector3) {
  if (direction.lengthSq() < 1e-8) return []
  const length = direction.length()
  return arms.filter((arm) => arm.attached && arm.capacity > 0 && arm.strain < 0.15)
    .map((arm) => ({ id: arm.id, score: -arm.direction.dot(direction) / length, extension: 0.15 - arm.strain }))
    .filter((arm) => arm.score > 0.1)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export interface JetSettings {
  period: number
  contraction: number
  capacity: number
  expelled: number
  nozzle: number
  flowLoss: number
  stiffness: number
  damping: number
  thrustCap: number
}

/** 35 ml and 1.6 Hz are the Renda 2015 robot benchmark; duty, expulsion fraction and elastic coefficients are sim choices. */
export const REFERENCE_JET: JetSettings = {
  period: 1 / 1.6,
  contraction: (1 / 1.6) / 3,
  capacity: 35e-6,
  expelled: 0.35,
  nozzle: Math.PI * 0.004 ** 2,
  flowLoss: 0.8,
  stiffness: 600,
  damping: 42,
  thrustCap: 2,
}

/** Muscle pressure contracts a compliant mantle. Elastic recoil refills it; only outward flow through the siphon produces thrust. */
export class JetMantle {
  fraction = 1
  rate = 0
  flow = 0
  thrust = 0
  pulses = 0
  elapsed = Infinity
  constructor(readonly settings: JetSettings = REFERENCE_JET) {
    if (!Object.values(settings).every((value) => Number.isFinite(value) && value > 0) ||
      settings.contraction >= settings.period || settings.expelled >= 1 || settings.flowLoss > 1)
      throw new Error('Invalid jet profile')
  }
  pulse() {
    if (this.elapsed + 1e-10 < this.settings.period || this.fraction < 0.97) return false
    this.elapsed = 0
    this.pulses++
    return true
  }
  step(dt: number) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 1 / 30) return this.thrust
    const steps = Math.ceil(dt * 240),
      h = dt / steps,
      p = this.settings
    let impulse = 0
    for (let i = 0; i < steps; i++) {
      const contracting = this.elapsed + 1e-10 < p.contraction,
        equilibrium = contracting ? 1 - p.expelled : 1
      this.rate += (p.stiffness * (equilibrium - this.fraction) - p.damping * this.rate) * h
      this.rate = clamp(this.rate, -8, 8)
      const next = this.fraction + this.rate * h
      this.fraction = clamp(next, 1 - p.expelled, 1)
      if (next !== this.fraction) this.rate = 0
      this.flow = contracting ? Math.max(0, -this.rate * p.capacity) : 0
      impulse += Math.min(p.thrustCap, (1000 * p.flowLoss * this.flow * this.flow) / p.nozzle) * h
      this.elapsed += h
    }
    this.thrust = impulse / dt
    return this.thrust
  }
}
