/** Antagonistic routed stroke with a separate extension channel. The hardware paths do not use this sim elasticity. */
import { bounded, clamp, finite, straight, validateSection, type ContinuumArm, type ContinuumProfile, type Section, type Shape } from './profile'

export type Strokes = [number, number, number, number]

/** Quadrant routes have signed pay-out, not signed tension. Shared stroke saturation preserves the bend direction. */
export function route(section: Section, value: Shape, out: Strokes = [0, 0, 0, 0], scratch = straight()): Strokes {
  const q = bounded(section, value, scratch),
    length = section.length * (1 + q.strain),
    radius = section.routeRadius / Math.sqrt(1 + q.strain),
    common = section.length * q.strain,
    x = length * radius * q.kx,
    y = length * radius * q.ky,
    excursion = Math.max(Math.abs(x), Math.abs(y)),
    scale = excursion ? Math.min(1, (section.stroke - Math.abs(common)) / excursion) : 1
  out[0] = common - y * scale
  out[1] = common + x * scale
  out[2] = common + y * scale
  out[3] = common - x * scale
  return out
}

export function unroute(section: Section, strokes: readonly number[], twist = 0, out: Shape = straight()): Shape {
  const a = clamp(finite(strokes[0]), -section.stroke, section.stroke),
    b = clamp(finite(strokes[1]), -section.stroke, section.stroke),
    c = clamp(finite(strokes[2]), -section.stroke, section.stroke),
    d = clamp(finite(strokes[3]), -section.stroke, section.stroke)
  out.strain = clamp((a + b + c + d) / (4 * section.length), ...section.strain)
  const factor = section.length * (1 + out.strain) * (section.routeRadius / Math.sqrt(1 + out.strain))
  out.kx = factor ? (b - d) / (2 * factor) : 0
  out.ky = factor ? (c - a) / (2 * factor) : 0
  out.twist = twist
  return bounded(section, out, out)
}

interface Spring {
  x: number
  v: number
}
interface SectionState {
  strokes: Strokes
  targets: Strokes
  springs: Spring[]
  torsion: Spring
  tensions: Strokes
}

export class ArmTendons {
  readonly pose: Shape[]
  readonly state: SectionState[]
  private target = straight()
  private zero = straight()
  private routing = straight()
  constructor(readonly profile: ContinuumProfile, readonly arm: ContinuumArm) {
    arm.sections.forEach(validateSection)
    this.pose = arm.sections.map(straight)
    this.state = arm.sections.map(() => ({
      strokes: [0, 0, 0, 0],
      targets: [0, 0, 0, 0],
      springs: Array.from({ length: 4 }, () => ({ x: 0, v: 0 })),
      torsion: { x: 0, v: 0 },
      tensions: [2, 2, 2, 2],
    }))
  }
  /** Call on fixed simulation ticks. 240 Hz substeps match the existing tendon layer's integration policy. */
  step(targets: readonly Shape[], dt: number, water = 0, activation: readonly number[] = []) {
    if (!Number.isFinite(dt) || dt <= 0) return this.pose
    const elapsed = Math.min(dt, 1 / 30),
      steps = Math.ceil(elapsed * 240),
      h = elapsed / steps,
      settings = this.profile.elasticity,
      damping = settings.airDamping + (settings.waterDamping - settings.airDamping) * clamp(finite(water), 0, 1)
    for (let i = 0; i < this.state.length; i++) {
      const section = this.arm.sections[i],
        state = this.state[i]
      bounded(section, targets[i] ?? this.zero, this.target)
      route(section, this.target, state.targets, this.routing)
      const muscle = 1 + 2 * clamp(finite(activation[i]), 0, 1),
        stiffness = settings.stiffness * muscle,
        drag = damping * Math.sqrt(muscle)
      for (let n = 0; n < steps; n++) {
        for (let j = 0; j < 4; j++) {
          const spring = state.springs[j]
          spring.v += (stiffness * (state.targets[j] - spring.x) - drag * spring.v) * h
          spring.v = clamp(spring.v, -section.strokeRate, section.strokeRate)
          spring.x = clamp(spring.x + spring.v * h, -section.stroke, section.stroke)
          state.strokes[j] = spring.x
          // The pretension and effective cable stiffness are bounded visual sim values, not measured tendon forces.
          state.tensions[j] = clamp(2 + 1000 * (spring.x - state.targets[j]), 0, 12)
        }
        const spring = state.torsion
        spring.v += (stiffness * (this.target.twist - spring.x) - drag * spring.v) * h
        spring.v = clamp(spring.v, -2, 2)
        spring.x += spring.v * h
      }
      unroute(section, state.strokes, state.torsion.x, this.pose[i])
      state.torsion.x = this.pose[i].twist
    }
    return this.pose
  }
  /** A bounded contact impulse excites the elastic state; it cannot rewrite input targets. */
  contact(section: number, routeIndex: number, impulse: number) {
    const spring = this.state[section]?.springs[routeIndex]
    if (spring) spring.v = clamp(spring.v + clamp(finite(impulse), -0.05, 0.05), -0.25, 0.25)
  }
  freeze() {
    for (const state of this.state) {
      for (const spring of state.springs) spring.v = 0
      state.torsion.v = 0
    }
  }
  reset() {
    for (let i = 0; i < this.state.length; i++) {
      const state = this.state[i]
      for (const spring of state.springs) Object.assign(spring, { x: 0, v: 0 })
      Object.assign(state.torsion, { x: 0, v: 0 })
      state.strokes.fill(0)
      state.targets.fill(0)
      state.tensions.fill(2)
      Object.assign(this.pose[i], straight())
    }
  }
}

/** Presentation cadence cannot change physics. A long pause discards debt instead of replaying a command burst. */
export class ContinuumClock {
  readonly dt = 1 / 120
  ticks = 0
  paused = false
  private pending = 0
  advance(elapsed: number, tick: (dt: number, time: number) => void) {
    if (!Number.isFinite(elapsed) || elapsed <= 0) return 0
    if (elapsed > this.dt * 8 + 1e-9) {
      this.pending = 0
      this.paused = true
      return 0
    }
    this.paused = false
    this.pending += elapsed
    let count = 0
    while (this.pending + 1e-10 >= this.dt && count < 8) {
      tick(this.dt, this.ticks * this.dt)
      this.pending -= this.dt
      this.ticks++
      count++
    }
    return count
  }
  reset() {
    this.pending = 0
    this.ticks = 0
    this.paused = false
  }
}
