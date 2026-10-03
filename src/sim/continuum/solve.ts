/**
 * Damped least-squares placement for one continuum arm. Named material points move toward targets, the arm's surface
 * stays on or above a supporting plane, and a weak bias holds the rest of its shape. Bend, strain and their limits are
 * the profile's own. This is kinematic placement over the reduced PCC model: it decides where an arm lies, not the
 * forces in it, and it is not a rod or contact-force solver.
 */
import { Vector3 } from 'three'
import { frame, sectionFrame, type Frame } from './kinematics'
import { bounded, clamp, finite, straight, validateSection, type ContinuumArm, type Shape } from './profile'

/** A material point (0 root, 1 tip) and where it should be, in the arm's body frame. Inactive goals cost nothing. */
export interface Goal {
  fraction: number
  target: Vector3
  weight: number
  active: boolean
}

/** Per section: bend about local x, bend about local y, and length strain. Twist stays with the tendon layer. */
const PER = 3
/** Floor samples per section, and the finite-difference step in parameter units (1/m for bends, unitless for strain). */
const SAMPLES = 2
const STEP = 1e-4
/** How far above the plane a surface sample must stay before its floor row lets go, in metres. */
export const FLOOR_MARGIN = 0.003

/**
 * Surface radius along the arm: a linear taper between the first and last sections, then a final narrowing over the
 * last eighth to half the last section's radius at the tip; narrowed by elongation (constant volume).
 */
export function surfaceRadius(arm: ContinuumArm, fraction: number, strain = 0) {
  const f = clamp(finite(fraction), 0, 1), first = arm.sections[0].radius, last = arm.sections[arm.sections.length - 1].radius
  const tip = f > 0.875 ? 1 - 0.5 * ((f - 0.875) / 0.125) ** 1.5 : 1
  return ((first + (last - first) * f) * tip) / Math.sqrt(1 + clamp(finite(strain), -0.5, 1))
}

export class ArmSolver {
  /** The current solution, warm-started from call to call: [kx, ky, strain] per section. */
  readonly params: Float64Array
  /** The shape the solver relaxes toward where goals and the floor leave freedom, and how strongly per parameter. */
  readonly bias: Float64Array
  readonly biasWeight: Float64Array
  readonly goals: Goal[]
  /** The supporting plane in the body frame: points satisfy normal·p ≥ offset + surface radius. */
  readonly floorNormal = new Vector3(0, 1, 0)
  floorOffset = -Infinity
  floorWeight = 100
  /** The least Levenberg-Marquardt damping; it rises after a rejected step and falls back after accepted ones. */
  damping = 0.002
  private lambda = 0.002
  /** The largest goal miss after the last solve, in metres. */
  residual = 0
  readonly shapes: Shape[]

  private readonly count: number
  private readonly fractions: { section: number; local: number }[]
  private readonly bases: Frame[]
  private readonly points: Vector3[]
  private readonly base: Vector3[]
  private readonly local = frame()
  private readonly scratch = straight()
  private readonly jac: Float64Array
  private readonly normal: Float64Array
  private readonly system: Float64Array
  private readonly gradient: Float64Array
  private readonly delta: Float64Array
  private readonly before: Float64Array
  private readonly fixed: Uint8Array
  private readonly lengths: number[]

  constructor(readonly arm: ContinuumArm, goals = 2) {
    arm.sections.forEach(validateSection)
    const n = arm.sections.length
    this.count = n * PER
    this.params = new Float64Array(this.count)
    this.bias = new Float64Array(this.count)
    this.biasWeight = new Float64Array(this.count).fill(0.05)
    this.goals = Array.from({ length: goals }, () => ({ fraction: 1, target: new Vector3(), weight: 1, active: false }))
    this.shapes = arm.sections.map(straight)
    this.lengths = arm.sections.map((s) => s.length)
    const total = this.lengths.reduce((a, b) => a + b, 0)
    // Floor samples sit at the middle and end of each section; goal points follow them in the same list.
    const samples: number[] = []
    for (let i = 0; i < n; i++) for (let k = 1; k <= SAMPLES; k++) samples.push((i + k / SAMPLES) / n)
    this.fractions = [...samples, ...this.goals.map(() => 0)].map(() => ({ section: 0, local: 0 }))
    samples.forEach((f, i) => this.locate(f * total, this.fractions[i]))
    this.bases = Array.from({ length: n + 1 }, frame)
    this.points = this.fractions.map(() => new Vector3())
    this.base = this.fractions.map(() => new Vector3())
    const rows = this.fractions.length * 3 + this.count
    this.jac = new Float64Array(rows * this.count)
    this.normal = new Float64Array(this.count * this.count)
    this.system = new Float64Array(this.count * this.count)
    this.gradient = new Float64Array(this.count)
    this.delta = new Float64Array(this.count)
    this.before = new Float64Array(this.count)
    this.fixed = new Uint8Array(this.count)
  }

  private locate(distance: number, out: { section: number; local: number }) {
    let section = 0
    while (section < this.lengths.length - 1 && distance > this.lengths[section] + 1e-12) {
      distance -= this.lengths[section]
      section++
    }
    out.section = section
    out.local = clamp(distance / this.lengths[section], 0, 1)
  }

  /** Copy a pose in (shapes from the tendon layer, say), so the next solve continues from where the arm is. */
  seed(shapes: readonly Shape[]) {
    for (let i = 0; i < this.arm.sections.length; i++) {
      const s = bounded(this.arm.sections[i], shapes[i] ?? this.scratch, this.scratch)
      this.params[i * PER] = s.kx
      this.params[i * PER + 1] = s.ky
      this.params[i * PER + 2] = s.strain
    }
    this.write()
  }

  /** Set the bias for one section, as bend angles (radians) across its rest length and a strain. */
  relax(section: number, angleX: number, angleY: number, strain: number, weight = 0.05) {
    const length = this.lengths[section]
    this.bias[section * PER] = finite(angleX) / length
    this.bias[section * PER + 1] = finite(angleY) / length
    this.bias[section * PER + 2] = finite(strain)
    this.biasWeight.fill(weight, section * PER, section * PER + PER)
  }

  private shape(i: number, out: Shape) {
    out.kx = this.params[i * PER]
    out.ky = this.params[i * PER + 1]
    out.strain = this.params[i * PER + 2]
    out.twist = 0
    return bounded(this.arm.sections[i], out, out)
  }

  /** Section base frames from `from` onward, then every listed point whose section is at or after it. */
  private forward(from: number) {
    const sections = this.arm.sections
    if (from === 0) {
      this.bases[0].position.copy(this.arm.position)
      this.bases[0].orientation.copy(this.arm.orientation)
    }
    for (let i = from; i < sections.length; i++) {
      sectionFrame(sections[i], this.shape(i, this.scratch), 1, this.local)
      const base = this.bases[i], next = this.bases[i + 1]
      next.position.copy(this.local.position).applyQuaternion(base.orientation).add(base.position)
      next.orientation.copy(base.orientation).multiply(this.local.orientation)
    }
    for (let p = 0; p < this.fractions.length; p++) {
      const f = this.fractions[p]
      if (f.section < from) continue
      const base = this.bases[f.section]
      sectionFrame(sections[f.section], this.shape(f.section, this.scratch), f.local, this.local)
      this.points[p].copy(this.local.position).applyQuaternion(base.orientation).add(base.position)
    }
  }

  /** Where a material point lies in the body frame for the current solution. */
  pointAt(fraction: number, out: Vector3) {
    const at = { section: 0, local: 0 }
    this.locate(clamp(finite(fraction), 0, 1) * this.lengths.reduce((a, b) => a + b, 0), at)
    this.forward(0)
    const base = this.bases[at.section]
    sectionFrame(this.arm.sections[at.section], this.shape(at.section, this.scratch), at.local, this.local)
    return out.copy(this.local.position).applyQuaternion(base.orientation).add(base.position)
  }

  /**
   * A few Gauss-Newton steps with Levenberg-Marquardt damping. Rows: three per active goal, one per floor sample inside
   * the margin (one-sided), and one bias row per parameter. Finite differences recompute only the sections at and after
   * the one perturbed. A strain held at its limit leaves the step, and a step that raises the cost is refused and retried
   * with more damping, so every accepted step descends. No allocation per call.
   */
  solve(iterations = 2) {
    const n = this.count, samples = this.arm.sections.length * SAMPLES, goals = this.goals
    const total = this.lengths.reduce((a, b) => a + b, 0)
    goals.forEach((g, i) => this.locate(clamp(finite(g.fraction), 0, 1) * total, this.fractions[samples + i]))
    for (let iteration = 0; iteration < Math.max(1, Math.min(6, iterations)); iteration++) {
      this.forward(0)
      for (let p = 0; p < this.points.length; p++) this.base[p].copy(this.points[p])
      const rows = this.rowsAt(this.base, true)
      let cost = 0
      for (let r = 0; r < rows; r++) cost += this.rowResidual[r] ** 2
      // Last section first: each perturbation then starts from a base frame no earlier column has disturbed.
      for (let j = n - 1; j >= 0; j--) {
        const section = Math.floor(j / PER), value = this.params[j]
        this.params[j] = value + STEP
        this.forward(section)
        this.params[j] = value
        this.columnAt(j, section)
      }
      this.normal.fill(0)
      this.gradient.fill(0)
      for (let r = 0; r < rows; r++) {
        const residual = this.rowResidual[r]
        for (let a = 0; a < n; a++) {
          const ja = this.jac[r * n + a]
          if (!ja) continue
          this.gradient[a] += ja * residual
          for (let b = a; b < n; b++) this.normal[a * n + b] += ja * this.jac[r * n + b]
        }
      }
      for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) this.normal[a * n + b] = this.normal[b * n + a]
      this.before.set(this.params)
      this.fixed.fill(0)
      let accepted = false
      for (let attempt = 0; attempt < 4 && !accepted; attempt++) {
        if (!this.step()) break
        // A strain the step would push past its limit stays where it is; the others are solved again without it.
        let pinned = false
        for (let j = 2; j < n; j += PER) {
          const limits = this.arm.sections[Math.floor(j / PER)].strain, next = this.before[j] - this.delta[j]
          if (!this.fixed[j] && (next < limits[0] && this.before[j] <= limits[0] + 1e-9 || next > limits[1] && this.before[j] >= limits[1] - 1e-9)) {
            this.fixed[j] = 1
            pinned = true
          }
        }
        if (pinned && !this.step()) break
        // A trust region per step: bends move at most 2 per metre, strain at most 0.05.
        for (let j = 0; j < n; j++)
          this.params[j] = this.before[j] - (j % PER === 2 ? clamp(this.delta[j], -0.05, 0.05) : clamp(this.delta[j], -2, 2))
        this.write()
        this.forward(0)
        const next = this.rowsAt(this.points, true)
        let after = 0
        for (let r = 0; r < next; r++) after += this.rowResidual[r] ** 2
        if (after <= cost + 1e-12) {
          accepted = true
          this.lambda = Math.max(this.damping, this.lambda / 3)
        } else {
          this.params.set(this.before)
          this.lambda = Math.min(10, this.lambda * 4)
        }
      }
      if (!accepted) {
        this.params.set(this.before)
        this.write()
        break
      }
    }
    this.forward(0)
    this.residual = 0
    for (let g = 0; g < goals.length; g++)
      if (goals[g].active) this.residual = Math.max(this.residual, this.points[samples + g].distanceTo(goals[g].target))
    return this.residual
  }

  /** Solve (normal + lambda I) delta = gradient, with fixed parameters held out. */
  private step() {
    const n = this.count
    this.system.set(this.normal)
    for (let a = 0; a < n; a++) {
      this.system[a * n + a] += this.lambda
      if (!this.fixed[a]) continue
      for (let b = 0; b < n; b++) this.system[a * n + b] = this.system[b * n + a] = 0
      this.system[a * n + a] = 1
    }
    return this.choleskySolve()
  }

  private rowResidual = new Float64Array(64)
  private rowKind = new Int16Array(64)
  private rowWeight = new Float64Array(64)

  /** Fill residuals (when `record`) and return the row count. Row order: goals, floor, bias. */
  private rowsAt(points: readonly Vector3[], record: boolean) {
    const samples = this.arm.sections.length * SAMPLES
    let r = 0
    for (let g = 0; g < this.goals.length; g++) {
      const goal = this.goals[g]
      if (!goal.active) continue
      const w = Math.sqrt(Math.max(0, finite(goal.weight))), p = points[samples + g]
      for (let axis = 0; axis < 3; axis++) {
        if (record) {
          this.rowKind[r] = (samples + g) * 4 + axis
          this.rowWeight[r] = w
          this.rowResidual[r] = w * (p.getComponent(axis) - goal.target.getComponent(axis))
        }
        r++
      }
    }
    if (Number.isFinite(this.floorOffset)) {
      const w = Math.sqrt(this.floorWeight)
      for (let s = 0; s < samples; s++) {
        const f = (s + 1) / samples, clearance = this.floorNormal.dot(points[s]) - this.floorOffset - surfaceRadius(this.arm, f)
        // One-sided: a row joins only inside the margin, and then only pushes outward to it.
        if (clearance >= FLOOR_MARGIN) continue
        if (record) {
          this.rowKind[r] = s * 4 + 3
          this.rowWeight[r] = w
          this.rowResidual[r] = w * (clearance - FLOOR_MARGIN)
        }
        r++
      }
    }
    for (let j = 0; j < this.count; j++) {
      if (record) {
        const scale = j % PER === 2 ? 1 : this.lengths[Math.floor(j / PER)], w = Math.sqrt(this.biasWeight[j])
        this.rowKind[r] = -1 - j
        this.rowWeight[r] = w * scale
        this.rowResidual[r] = w * scale * (this.params[j] - this.bias[j])
      }
      r++
    }
    this.rows = r
    return r
  }
  private rows = 0

  /** One Jacobian column from the perturbed points against the base points. */
  private columnAt(j: number, section: number) {
    const n = this.count
    for (let r = 0; r < this.rows; r++) {
      const kind = this.rowKind[r]
      let value = 0
      if (kind < 0) value = -1 - kind === j ? this.rowWeight[r] : 0
      else {
        const point = kind >> 2, axis = kind & 3
        if (this.fractions[point].section >= section) {
          const moved = this.points[point], base = this.base[point]
          value = axis < 3
            ? (moved.getComponent(axis) - base.getComponent(axis)) / STEP
            : (this.floorNormal.dot(moved) - this.floorNormal.dot(base)) / STEP
          value *= this.rowWeight[r]
        }
      }
      this.jac[r * n + j] = value
    }
  }

  /** Solve system · delta = gradient by Cholesky, in place in the system; false if it is not positive definite. */
  private choleskySolve() {
    const n = this.count, a = this.system, x = this.delta
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = a[i * n + j]
        for (let k = 0; k < j; k++) sum -= a[i * n + k] * a[j * n + k]
        if (i === j) {
          if (!(sum > 1e-12)) return false
          a[i * n + i] = Math.sqrt(sum)
        } else a[i * n + j] = sum / a[j * n + j]
      }
    }
    for (let i = 0; i < n; i++) {
      let sum = this.fixed[i] ? 0 : this.gradient[i]
      for (let k = 0; k < i; k++) sum -= a[i * n + k] * x[k]
      x[i] = sum / a[i * n + i]
    }
    for (let i = n - 1; i >= 0; i--) {
      let sum = x[i]
      for (let k = i + 1; k < n; k++) sum -= a[k * n + i] * x[k]
      x[i] = sum / a[i * n + i]
    }
    return x.every(Number.isFinite)
  }

  /** Clamp the solution to the profile's limits and publish it as shapes. */
  private write() {
    for (let i = 0; i < this.arm.sections.length; i++) {
      const s = this.shape(i, this.shapes[i])
      this.params[i * PER] = s.kx
      this.params[i * PER + 1] = s.ky
      this.params[i * PER + 2] = s.strain
    }
  }
}
