/**
 * A soft arm as a damped position-based rod (Müller et al. 2007, "Position based dynamics"): a chain of particles whose
 * segment lengths are set by a longitudinal muscle (elongation), whose joints relax toward a target bend with a
 * stiffness that falls from root to tip, and which moves through viscous, water-like damping under gravity. The
 * section narrows as it elongates and thickens as it shortens, at constant volume (Kier & Smith 1985; Yekutieli et al.
 * 2005). Particles can be held by suckers to a point in the world or on an object. This is a reduced, kinematically
 * stable rod for display and control: it is not a Cosserat solver and its stiffness and damping are design values.
 * Fixed steps, no randomness and no allocation per step.
 */
import { Vector3 } from 'three'
import { clamp, finite, type ContinuumArm } from './profile'

/** Segments per arm. Seventeen particles: enough for travelling waves, few enough for many arms at 120 Hz. */
export const ROD_SEGMENTS = 16
/**
 * The most one pass corrects a length, a bend or an aim, in metres. Soft tissue changes shape over several steps, so
 * no change of target or release of a hold can snap the rod.
 */
const MOST = 0.01, BEND_MOST = 0.005, AIM_MOST = 0.004, SMOOTH = 0.12

/** Surface radius along the arm: a linear taper between the first and last sections, narrowing over the last eighth. */
export function surfaceRadius(arm: ContinuumArm, fraction: number, stretch = 1) {
  const f = clamp(finite(fraction), 0, 1), first = arm.sections[0].radius, last = arm.sections[arm.sections.length - 1].radius
  const tip = f > 0.875 ? 1 - 0.55 * ((f - 0.875) / 0.125) ** 1.5 : 1
  return ((first + (last - first) * f) * tip) / Math.sqrt(clamp(finite(stretch, 1), 0.5, 2))
}

/** What holds a particle: nothing, a sucker on the floor (or wall), or a sucker on the carried object. */
export const FREE = 0, FLOOR = 1, OBJECT = 2

export interface RodSettings {
  /** Joint stiffness at the root and at the tip, as the fraction of the bend error corrected per iteration. */
  rootStiffness: number
  tipStiffness: number
  /** Viscous damping per second; contact friction removes this fraction of sliding per step. */
  damping: number
  friction: number
  gravity: number
  /** The fastest a particle may move, metres a second. */
  fastest: number
  iterations: number
}

/** Water-like damping and a stiffness that falls toward the tip. Design values, chosen for a slow, heavy, soft look. */
export const SOFT_ARM: RodSettings = { rootStiffness: 0.55, tipStiffness: 0.12, damping: 5, friction: 0.45, gravity: 6, fastest: 1.6, iterations: 4 }

const t = new Vector3(), n = new Vector3(), b = new Vector3(), d = new Vector3(), v = new Vector3(), w = new Vector3()

export class ArmRod {
  readonly count = ROD_SEGMENTS + 1
  /** World positions and the previous step's, three numbers per particle. */
  readonly position: Float64Array
  readonly previous: Float64Array
  /** Rest length of one segment, and each segment's muscle elongation (1 rest, below 1 shortened). */
  readonly rest: number
  readonly stretch: Float64Array
  /** Target bend at each joint, radians: toward the oral side (+) or back (-), and to the arm's right (+). */
  readonly bendOral: Float64Array
  readonly bendSide: Float64Array
  /** What holds each particle, and where. */
  readonly held: Uint8Array
  readonly anchor: Float64Array
  /** Touching the floor after the last step. */
  readonly contact: Uint8Array
  /** The oral-side normal at each particle after the last step (parallel transport from the root). */
  readonly normal: Float64Array
  /** An optional soft pull of particles before `aimUntil` toward the line from the root to `aim`. */
  readonly aim = new Vector3()
  aimUntil = 0
  aimStrength = 0
  /** An optional wrap: joints after `wrapFrom` bend toward `wrapCentre` with radius `wrapRadius`. */
  readonly wrapCentre = new Vector3()
  wrapFrom = 2
  wrapRadius = 0
  private readonly stiffness: Float64Array
  private readonly inverse: Float64Array
  private readonly radius: Float64Array

  constructor(readonly arm: ContinuumArm, readonly settings: RodSettings = SOFT_ARM) {
    const length = arm.sections.reduce((sum, s) => sum + s.length, 0)
    this.rest = length / ROD_SEGMENTS
    this.position = new Float64Array(this.count * 3)
    this.previous = new Float64Array(this.count * 3)
    this.anchor = new Float64Array(this.count * 3)
    this.normal = new Float64Array(this.count * 3)
    this.stretch = new Float64Array(ROD_SEGMENTS).fill(1)
    this.bendOral = new Float64Array(this.count)
    this.bendSide = new Float64Array(this.count)
    this.held = new Uint8Array(this.count)
    this.contact = new Uint8Array(this.count)
    this.stiffness = new Float64Array(this.count)
    this.inverse = new Float64Array(this.count)
    this.radius = new Float64Array(this.count)
    for (let i = 0; i < this.count; i++) {
      const f = i / ROD_SEGMENTS
      this.stiffness[i] = settings.rootStiffness + (settings.tipStiffness - settings.rootStiffness) * f
      this.radius[i] = surfaceRadius(arm, f)
      // Mass follows the cross-section, so the thin tip is light and moves most.
      this.inverse[i] = (this.radius[0] / Math.max(1e-3, this.radius[i])) ** 2
    }
  }

  /** Lay the rod out straight from a root along a direction, at rest. */
  place(root: Vector3, direction: Vector3, up: Vector3) {
    for (let i = 0; i < this.count; i++) {
      const k = i * 3, s = i * this.rest
      this.position[k] = this.previous[k] = root.x + direction.x * s
      this.position[k + 1] = this.previous[k + 1] = root.y + direction.y * s
      this.position[k + 2] = this.previous[k + 2] = root.z + direction.z * s
      this.normal[k] = up.x; this.normal[k + 1] = up.y; this.normal[k + 2] = up.z
    }
    this.held.fill(FREE)
  }

  /** Hold a particle where it is. */
  hold(i: number, kind = FLOOR) {
    const k = i * 3
    this.held[i] = kind
    this.anchor[k] = this.position[k]; this.anchor[k + 1] = this.position[k + 1]; this.anchor[k + 2] = this.position[k + 2]
  }

  /** Set each segment's elongation to its present length, so a change of muscle state starts from where the arm is. */
  sync() {
    const p = this.position
    for (let s = 1; s < ROD_SEGMENTS; s++) {
      const a = s * 3, c = a + 3
      this.stretch[s] = clamp(Math.hypot(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]) / this.rest, 0.55, 1.6)
    }
  }

  /** Arc length from the root to particle `i` at the current muscle elongation. */
  lengthTo(i: number) {
    let sum = 0
    for (let s = 0; s < Math.min(i, ROD_SEGMENTS); s++) sum += this.rest * this.stretch[s]
    return sum
  }

  /**
   * One fixed step. The root particle and the first segment follow the body (`root`, `direction`); `up` is the root's
   * dorsal axis, from which the oral-side frame is carried along the arm. The floor is the plane y = `floor`.
   */
  step(dt: number, root: Vector3, direction: Vector3, up: Vector3, floor: number) {
    if (!(dt > 0) || !Number.isFinite(dt)) return
    const p = this.position, q = this.previous, s = this.settings, count = this.count
    const keep = Math.exp(-s.damping * dt), drop = s.gravity * dt * dt
    // Verlet with viscous damping; held particles stay on their anchors.
    for (let i = 2; i < count; i++) {
      const k = i * 3
      if (this.held[i]) continue
      let vx = (p[k] - q[k]) * keep, vy = (p[k + 1] - q[k + 1]) * keep, vz = (p[k + 2] - q[k + 2]) * keep
      // Soft tissue in water does not whip: a particle moves at most `fastest` metres a second.
      const v2 = vx * vx + vy * vy + vz * vz, most = s.fastest * dt
      if (v2 > most * most) { const k2 = most / Math.sqrt(v2); vx *= k2; vy *= k2; vz *= k2 }
      q[k] = p[k]; q[k + 1] = p[k + 1]; q[k + 2] = p[k + 2]
      p[k] += vx; p[k + 1] += vy - drop; p[k + 2] += vz
    }
    for (let iteration = 0; iteration < s.iterations; iteration++) {
      this.pinRoot(root, direction)
      this.lengths()
      this.bend(up)
      this.smooth()
      this.lengths()
      this.floor(floor)
      this.anchors()
    }
    this.pinRoot(root, direction)
    // However the constraints pull, a free particle travels at most `sweep` a step; what is left resolves next step.
    const sweep = s.fastest * 1.8 * dt
    for (let i = 2; i < count; i++) {
      const k = i * 3
      if (this.held[i]) continue
      const dx = p[k] - q[k], dy = p[k + 1] - q[k + 1], dz = p[k + 2] - q[k + 2], moved = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (moved <= sweep) continue
      const keep = sweep / moved
      p[k] = q[k] + dx * keep; p[k + 1] = q[k + 1] + dy * keep; p[k + 2] = q[k + 2] + dz * keep
    }
    // Friction: a particle on the floor loses most of its sliding.
    for (let i = 2; i < count; i++) {
      const k = i * 3
      if (this.held[i]) { q[k] = p[k]; q[k + 1] = p[k + 1]; q[k + 2] = p[k + 2]; continue }
      if (!this.contact[i]) continue
      q[k] += (p[k] - q[k]) * s.friction
      q[k + 2] += (p[k + 2] - q[k + 2]) * s.friction
    }
    this.frames(up)
  }

  private pinRoot(root: Vector3, direction: Vector3) {
    const p = this.position, q = this.previous, l = this.rest * this.stretch[0]
    p[0] = q[0] = root.x; p[1] = q[1] = root.y; p[2] = q[2] = root.z
    p[3] = q[3] = root.x + direction.x * l; p[4] = q[4] = root.y + direction.y * l; p[5] = q[5] = root.z + direction.z * l
  }

  /** Segment lengths toward the muscle's elongation, both ways along the chain. */
  private lengths() {
    const p = this.position
    for (let pass = 0; pass < 2; pass++) for (let j = 0; j < ROD_SEGMENTS; j++) {
      const s = pass ? ROD_SEGMENTS - 1 - j : j, a = s * 3, c = a + 3
      const wa = s < 2 || this.held[s] ? 0 : this.inverse[s], wc = s + 1 < 2 || this.held[s + 1] ? 0 : this.inverse[s + 1]
      if (wa + wc <= 0) continue
      const dx = p[c] - p[a], dy = p[c + 1] - p[a + 1], dz = p[c + 2] - p[a + 2]
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9
      // A bounded correction per pass: a muscle changes length over several steps, never in one snap.
      const error = clamp(length - this.rest * this.stretch[s], -MOST, MOST) / length / (wa + wc)
      p[a] += dx * error * wa; p[a + 1] += dy * error * wa; p[a + 2] += dz * error * wa
      p[c] -= dx * error * wc; p[c + 1] -= dy * error * wc; p[c + 2] -= dz * error * wc
    }
  }

  /**
   * Joint bends, root to tip: the next particle moves toward where the target bend would put it, carried in the
   * frame the previous segment leaves (parallel transport keeps the oral side continuous, with no flips).
   */
  private bend(up: Vector3) {
    const p = this.position
    n.copy(up)
    for (let i = 1; i < ROD_SEGMENTS; i++) {
      const a = (i - 1) * 3, c = i * 3, e = c + 3
      t.set(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]).normalize()
      n.addScaledVector(t, -t.dot(n))
      if (n.lengthSq() < 1e-12) n.set(0, 1, 0).addScaledVector(t, -t.y)
      n.normalize()
      b.crossVectors(t, n)
      let oral = this.bendOral[i], side = this.bendSide[i]
      if (this.wrapRadius > 0 && i >= this.wrapFrom) {
        // Bend toward the object's centre, with the curvature of its surface.
        v.set(this.wrapCentre.x - p[c], this.wrapCentre.y - p[c + 1], this.wrapCentre.z - p[c + 2])
        const vn = v.dot(n), vb = v.dot(b), across = Math.hypot(vn, vb) || 1
        const angle = Math.min(0.5, (this.rest * this.stretch[i]) / this.wrapRadius)
        oral = -angle * vn / across
        side = angle * vb / across
      }
      // Toward the oral side is toward -n; to the right is toward +b.
      const co = Math.cos(oral), so = Math.sin(oral), cs = Math.cos(side), ss = Math.sin(side)
      d.copy(t).multiplyScalar(co).addScaledVector(n, -so)
      d.multiplyScalar(cs).addScaledVector(b, ss)
      const length = this.rest * this.stretch[i]
      if (this.held[i + 1]) continue
      const k = this.stiffness[i]
      w.set(p[c] + d.x * length, p[c + 1] + d.y * length, p[c + 2] + d.z * length)
      this.nudge(e, w, k, BEND_MOST)
      if (this.aimStrength > 0 && i + 1 <= this.aimUntil) {
        // Toward the straight line from the root to the aim, at the same arc length.
        const along = this.lengthTo(i + 1)
        w.set(this.aim.x - p[0], this.aim.y - p[1], this.aim.z - p[2])
        const reach = w.length() || 1
        w.multiplyScalar(along / reach).add(v.set(p[0], p[1], p[2]))
        this.nudge(e, w, this.aimStrength, AIM_MOST)
      }
      // Carry the frame on to the next joint.
    }
  }

  /**
   * Shortest-wavelength smoothing: each free particle moves a little toward the midpoint of its neighbours. It acts
   * only on zigzags (where a compressed chain would buckle back and forth), not on the arm's real curves.
   */
  private smooth() {
    const p = this.position
    for (let i = 2; i < ROD_SEGMENTS; i++) {
      if (this.held[i]) continue
      const a = (i - 1) * 3, k = i * 3, c = (i + 1) * 3
      p[k] += ((p[a] + p[c]) / 2 - p[k]) * SMOOTH
      p[k + 1] += ((p[a + 1] + p[c + 1]) / 2 - p[k + 1]) * SMOOTH
      p[k + 2] += ((p[a + 2] + p[c + 2]) / 2 - p[k + 2]) * SMOOTH
    }
  }

  /** Move particle `e` a fraction `k` toward `to`, by at most `most` metres. */
  private nudge(e: number, to: Vector3, k: number, most: number) {
    const p = this.position
    let dx = (to.x - p[e]) * k, dy = (to.y - p[e + 1]) * k, dz = (to.z - p[e + 2]) * k
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (length > most) { const s = most / length; dx *= s; dy *= s; dz *= s }
    p[e] += dx; p[e + 1] += dy; p[e + 2] += dz
  }

  private floor(level: number) {
    const p = this.position
    for (let i = 2; i < this.count; i++) {
      const k = i * 3, lowest = level + this.radius[i] * 0.85
      this.contact[i] = p[k + 1] <= lowest + 0.004 ? 1 : 0
      if (this.held[i] || p[k + 1] >= lowest) continue
      p[k + 1] = lowest
    }
  }

  private anchors() {
    const p = this.position, a = this.anchor
    for (let i = 2; i < this.count; i++) {
      if (!this.held[i]) continue
      const k = i * 3
      p[k] = a[k]; p[k + 1] = a[k + 1]; p[k + 2] = a[k + 2]
    }
  }

  /** The oral-side normal at every particle, carried from the root (for drawing and for the next step's bends). */
  private frames(up: Vector3) {
    const p = this.position
    n.copy(up)
    for (let i = 0; i < this.count; i++) {
      const a = Math.max(0, i - 1) * 3, c = Math.min(ROD_SEGMENTS, i + 1) * 3
      t.set(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]).normalize()
      n.addScaledVector(t, -t.dot(n))
      if (n.lengthSq() < 1e-12) n.set(0, 1, 0).addScaledVector(t, -t.y)
      n.normalize()
      this.normal[i * 3] = n.x; this.normal[i * 3 + 1] = n.y; this.normal[i * 3 + 2] = n.z
    }
  }

  /** The largest distance any particle moved in the last step (for smoothness checks). */
  speed() {
    let most = 0
    for (let i = 0; i < this.count; i++) {
      const k = i * 3
      most = Math.max(most, Math.hypot(this.position[k] - this.previous[k], this.position[k + 1] - this.previous[k + 1], this.position[k + 2] - this.previous[k + 2]))
    }
    return most
  }
}
