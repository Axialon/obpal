/** One contact model for air and water. Suction is finite pressure times sealed area, never an infinite position lock. */
import { Matrix4, Quaternion, Vector3 } from 'three'
import { clamp, finite, type ContinuumProfile, type CupSite } from './profile'

export interface SurfaceSample {
  point: Vector3
  normal: Vector3
  distance: number
}
const sample = (): SurfaceSample => ({ point: new Vector3(), normal: new Vector3(), distance: 0 })
const unitScale = new Vector3(1, 1, 1)
const identity = new Quaternion()
const finiteVector = (v: Vector3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)

/** Rigid, scale-free contact geometry. Glass/stone differ by declared grip, not by a second physics engine. */
export class ContactSurface {
  readonly matrix = new Matrix4()
  readonly inverse = new Matrix4()
  readonly orientation = new Quaternion()
  private local = new Vector3()
  private nearest = new Vector3()
  private normal = new Vector3()
  constructor(
    readonly id: string,
    readonly kind: 'plane' | 'box' | 'cylinder',
    readonly size: Vector3,
    readonly grip: number,
  ) {
    if (!size.toArray().every((n) => Number.isFinite(n) && n > 0) || grip < 0 || grip > 1 || !Number.isFinite(grip))
      throw new Error('Invalid contact surface')
  }
  pose(position: Vector3, orientation = identity) {
    if (!position.toArray().every(Number.isFinite) || !orientation.toArray().every(Number.isFinite) || orientation.lengthSq() < 1e-12)
      throw new Error('Invalid surface pose')
    this.orientation.copy(orientation).normalize()
    this.matrix.compose(position, this.orientation, unitScale)
    this.inverse.copy(this.matrix).invert()
    return this
  }
  sample(point: Vector3, out: SurfaceSample): SurfaceSample {
    this.local.copy(point).applyMatrix4(this.inverse)
    const p = this.local,
      q = this.nearest,
      n = this.normal
    if (this.kind === 'plane') {
      q.set(clamp(p.x, -this.size.x, this.size.x), clamp(p.y, -this.size.y, this.size.y), 0)
      n.set(0, 0, 1)
    } else if (this.kind === 'box') {
      q.set(clamp(p.x, -this.size.x, this.size.x), clamp(p.y, -this.size.y, this.size.y), clamp(p.z, -this.size.z, this.size.z))
      n.copy(p).sub(q)
      if (n.lengthSq() < 1e-16) {
        let axis = 0,
          distance = Infinity
        for (let i = 0; i < 3; i++) {
          const d = this.size.getComponent(i) - Math.abs(p.getComponent(i))
          if (d < distance) {
            axis = i
            distance = d
          }
        }
        const sign = p.getComponent(axis) < 0 ? -1 : 1
        q.setComponent(axis, sign * this.size.getComponent(axis))
        n.set(0, 0, 0).setComponent(axis, sign)
      } else n.normalize()
    } else {
      const radius = this.size.x,
        radial = Math.hypot(p.x, p.z),
        inside = radial <= radius && Math.abs(p.y) <= this.size.y,
        cap = inside ? this.size.y - Math.abs(p.y) < radius - radial : Math.abs(p.y) > this.size.y
      if (cap) {
        const scale = radial > radius ? radius / radial : 1,
          sign = p.y < 0 ? -1 : 1
        q.set(p.x * scale, sign * this.size.y, p.z * scale)
        n.copy(p).sub(q)
        if (inside || n.lengthSq() < 1e-16) n.set(0, sign, 0)
        else n.normalize()
      } else {
        const x = radial > 1e-10 ? p.x / radial : 1,
          z = radial > 1e-10 ? p.z / radial : 0
        q.set(x * radius, clamp(p.y, -this.size.y, this.size.y), z * radius)
        n.set(x, 0, z)
      }
    }
    out.point.copy(q).applyMatrix4(this.matrix)
    out.normal.copy(n).applyQuaternion(this.orientation)
    out.distance = (p.x - q.x) * n.x + (p.y - q.y) * n.y + (p.z - q.z) * n.z
    return out
  }
}

export interface CupInput {
  point: Vector3
  facing: Vector3
  velocity: Vector3
  attach: boolean
}
export type CupPhase = 'free' | 'sealing' | 'attached' | 'peeling' | 'broken'

/** An advancing rim front removes circular sealed area. This is a geometric peel model, not an animal timing fit. */
export function sealedArea(peel: number) {
  const x = 2 * clamp(finite(peel), 0, 1) - 1
  return (Math.acos(x) - x * Math.sqrt(Math.max(0, 1 - x * x))) / Math.PI
}

export class Sucker {
  phase: CupPhase = 'free'
  quality = 0
  pressure = 0
  area = 0
  limit = 0
  flash = 0
  flatten = 0
  readonly anchor = new Vector3()
  readonly normal = new Vector3()
  readonly force = new Vector3()
  private localAnchor = new Vector3()
  private localNormal = new Vector3()
  private lastAnchor = new Vector3()
  private anchorVelocity = new Vector3()
  private surface: ContactSurface | null = null
  private centre = sample()
  private rim = sample()
  private rimPoint = new Vector3()
  private tangent = new Vector3()
  private bitangent = new Vector3()
  private delta = new Vector3()
  private relative = new Vector3()
  private inverseOrientation = new Quaternion()
  private elapsed = 0
  private peelDelay = 0
  private latched = false
  constructor(readonly site: CupSite, readonly settings: ContinuumProfile['suction']) {
    if (!(site.radius > 0) || !Number.isFinite(site.radius) || !Object.values(settings).every((value) => Number.isFinite(value) && value > 0))
      throw new Error('Invalid sucker profile')
  }

  private seal(input: CupInput, surface: ContactSurface) {
    surface.sample(input.point, this.centre)
    const alignment = -input.facing.dot(this.centre.normal)
    if (alignment < 0.9 || this.centre.distance < -0.006 || this.centre.distance > 0.006) return 0
    this.tangent.set(1, 0, 0)
    if (Math.abs(input.facing.x) > 0.8) this.tangent.set(0, 1, 0)
    this.tangent.cross(input.facing).normalize()
    this.bitangent.crossVectors(input.facing, this.tangent).normalize()
    let covered = 0
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4
      this.rimPoint.copy(input.point)
        .addScaledVector(this.tangent, this.site.radius * Math.cos(angle))
        .addScaledVector(this.bitangent, this.site.radius * Math.sin(angle))
      surface.sample(this.rimPoint, this.rim)
      const gap = this.rim.point.distanceToSquared(this.rimPoint),
        lateral = Math.max(0, gap - this.rim.distance * this.rim.distance)
      if (gap < 0.008 ** 2 && lateral < 1e-8 && this.rim.normal.dot(this.centre.normal) > 0.9) covered++
    }
    // Pressure needs a closed rim: an uncovered edge is a leak, not merely a smaller grip factor.
    return covered === 8 ? surface.grip * alignment : 0
  }

  /** Release an arm from the distal cups first. Attached load is shed as the rim peels, not after a visual delay. */
  peel(delay = 0) {
    if (this.phase !== 'attached' && this.phase !== 'sealing') return
    if (this.phase === 'sealing') {
      this.phase = 'free'
      this.latched = true
      this.limit = this.area = this.pressure = this.flatten = 0
      this.force.set(0, 0, 0)
      return
    }
    this.phase = 'peeling'
    this.elapsed = 0
    this.peelDelay = Math.max(0, finite(delay))
    this.latched = true
  }
  private breakSeal() {
    this.phase = 'broken'
    this.latched = true
    this.limit = this.area = this.pressure = this.flatten = 0
    this.force.set(0, 0, 0)
  }

  /** Fixed ticks supply contact dwell and pressure dynamics. No image, landmark or wall-clock state enters here. */
  step(input: CupInput, surfaces: readonly ContactSurface[], dt: number, water = 0) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 1 / 30) return this.phase
    if (!finiteVector(input.point) || !finiteVector(input.facing) || !finiteVector(input.velocity) ||
      Math.abs(input.facing.lengthSq() - 1) > 0.01) {
      this.breakSeal()
      return this.phase
    }
    this.flash = Math.max(0, this.flash - dt)
    if (!input.attach) {
      if (this.phase === 'attached' || this.phase === 'sealing') this.peel()
      if (this.phase === 'free' || this.phase === 'broken') {
        this.latched = false
        this.phase = 'free'
      }
    }
    if (this.phase === 'free' && input.attach && !this.latched) {
      let best = 0
      this.surface = null
      for (const surface of surfaces) {
        const quality = this.seal(input, surface)
        if (quality > best || (quality > 0 && quality === best && (!this.surface || surface.id < this.surface.id))) {
          best = quality
          this.surface = surface
        }
      }
      if (best > 0) {
        this.quality = best
        this.elapsed = 0
        this.phase = 'sealing'
      }
    }
    const surface = this.surface
    if (!surface || this.phase === 'free' || this.phase === 'broken') return this.phase
    if (!surfaces.includes(surface)) {
      this.breakSeal()
      return this.phase
    }
    if (this.phase === 'sealing') {
      this.quality = this.seal(input, surface)
      if (!this.quality) {
        this.breakSeal()
        return this.phase
      }
      this.elapsed += dt
      this.pressure += (this.settings.pressure * this.quality - this.pressure) * (1 - Math.exp(-dt / 0.04))
      this.flatten = 1 - Math.exp(-this.elapsed / 0.04)
      if (this.elapsed + 1e-10 >= this.settings.sealTime) {
        surface.sample(input.point, this.centre)
        this.anchor.copy(this.centre.point)
        this.lastAnchor.copy(this.anchor)
        this.normal.copy(this.centre.normal)
        this.localAnchor.copy(this.anchor).applyMatrix4(surface.inverse)
        this.localNormal.copy(this.normal).applyQuaternion(this.inverseOrientation.copy(surface.orientation).invert())
        this.phase = 'attached'
        this.flash = 0.18
      }
    }
    this.area = Math.PI * this.site.radius * this.site.radius
    if (this.phase === 'peeling') {
      this.elapsed += dt
      const progress = Math.max(0, this.elapsed - this.peelDelay) / this.settings.releaseTime
      this.area *= sealedArea(progress)
      this.flatten = sealedArea(progress)
      if (progress >= 1) {
        this.phase = 'free'
        this.limit = this.area = this.pressure = this.flatten = 0
        this.force.set(0, 0, 0)
        return this.phase
      }
    }
    this.limit = this.pressure * this.area
    this.force.set(0, 0, 0)
    if (this.phase === 'attached' || this.phase === 'peeling') {
      this.anchor.copy(this.localAnchor).applyMatrix4(surface.matrix)
      this.normal.copy(this.localNormal).applyQuaternion(surface.orientation)
      this.anchorVelocity.copy(this.anchor).sub(this.lastAnchor).divideScalar(dt)
      this.lastAnchor.copy(this.anchor)
      this.delta.copy(input.point).sub(this.anchor)
      this.relative.copy(input.velocity).sub(this.anchorVelocity)
      this.force.copy(this.delta).multiplyScalar(-this.settings.stiffness)
        .addScaledVector(this.relative, -this.settings.damping * (1 + clamp(finite(water), 0, 1)))
      const normal = this.force.dot(this.normal),
        pull = Math.max(0, -normal),
        shear = Math.sqrt(Math.max(0, this.force.lengthSq() - normal * normal)),
        utilization = Math.hypot(pull, shear / this.settings.friction)
      if (this.delta.length() > this.settings.stretch || utilization > this.limit + 1e-8) this.breakSeal()
    }
    return this.phase
  }
}

export function peelArm(cups: readonly Sucker[], arm: string) {
  for (const cup of cups) if (cup.site.arm === arm) cup.peel((1 - cup.site.fraction) * 0.16)
}

export interface SupportResult {
  stable: boolean
  arms: number
  residual: number
  utilization: number
}

/** Distribute a requested wrench across anchors. Count, geometric rank and each pressure/friction cap all have to pass. */
export class SupportSolver {
  readonly forces: Vector3[]
  private matrix = new Float64Array(42)
  private delta = new Vector3()
  private force = new Vector3()
  private torque = new Vector3()
  private total = new Vector3()
  private totalMoment = new Vector3()
  private cross = new Vector3()
  private arms = new Set<string>()
  private active: Uint8Array
  private result: SupportResult = { stable: false, arms: 0, residual: Infinity, utilization: Infinity }
  constructor(readonly cups: readonly Sucker[], readonly settings: ContinuumProfile['support']) {
    this.forces = cups.map(() => new Vector3())
    this.active = new Uint8Array(cups.length)
  }
  private finish(arms: number, residual: number, utilization: number): SupportResult {
    this.result.stable = arms >= this.settings.minimumArms && residual < 1e-6 && utilization * this.settings.margin <= 1
    this.result.arms = arms
    this.result.residual = residual
    this.result.utilization = utilization
    if (!this.result.stable) for (const force of this.forces) force.set(0, 0, 0)
    return this.result
  }
  /** The result and force arrays are reused; callers copy them only when retaining a history sample. */
  solve(centre: Vector3, load: Vector3, moment: Vector3): SupportResult {
    const a = this.matrix
    this.arms.clear()
    this.active.fill(0)
    for (const force of this.forces) force.set(0, 0, 0)
    if (!finiteVector(centre) || !finiteVector(load) || !finiteVector(moment)) return this.finish(0, Infinity, Infinity)
    a.fill(0)
    let weightSum = 0, sx = 0, sy = 0, sz = 0,
      xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0
    for (let i = 0; i < this.cups.length; i++) {
      const cup = this.cups[i]
      if ((cup.phase !== 'attached' && cup.phase !== 'peeling') || cup.limit <= 1e-6) continue
      this.active[i] = 1
      this.arms.add(cup.site.arm)
      this.delta.copy(cup.anchor).sub(centre)
      const { x, y, z } = this.delta,
        weight = cup.limit * cup.limit
      weightSum += weight
      sx += weight * x
      sy += weight * y
      sz += weight * z
      xx += weight * x * x
      yy += weight * y * y
      zz += weight * z * z
      xy += weight * x * y
      xz += weight * x * z
      yz += weight * y * z
    }
    // Sum [I; cross(r)] W [I; cross(r)]^T analytically. The lower block is |r|² I − r r^T.
    a[0] = a[8] = a[16] = weightSum
    a[4] = a[28] = sz
    a[5] = a[35] = -sy
    a[10] = a[22] = -sz
    a[12] = a[36] = sx
    a[17] = a[23] = sy
    a[18] = a[30] = -sx
    a[24] = yy + zz
    a[32] = xx + zz
    a[40] = xx + yy
    a[25] = a[31] = -xy
    a[26] = a[38] = -xz
    a[33] = a[39] = -yz
    for (let i = 0; i < 3; i++) {
      a[i * 7 + 6] = load.getComponent(i)
      a[(i + 3) * 7 + 6] = moment.getComponent(i)
    }
    for (let col = 0; col < 6; col++) {
      let pivot = col
      for (let row = col + 1; row < 6; row++) if (Math.abs(a[row * 7 + col]) > Math.abs(a[pivot * 7 + col])) pivot = row
      if (Math.abs(a[pivot * 7 + col]) < 1e-8 || !Number.isFinite(a[pivot * 7 + col]))
        return this.finish(this.arms.size, Infinity, Infinity)
      for (let k = col; k < 7; k++) {
        const value = a[col * 7 + k]
        a[col * 7 + k] = a[pivot * 7 + k]
        a[pivot * 7 + k] = value
      }
      const divisor = a[col * 7 + col]
      for (let k = col; k < 7; k++) a[col * 7 + k] /= divisor
      for (let row = 0; row < 6; row++) {
        if (row === col) continue
        const value = a[row * 7 + col]
        for (let k = col; k < 7; k++) a[row * 7 + k] -= value * a[col * 7 + k]
      }
    }
    const translation = this.force.set(a[6], a[13], a[20]),
      rotation = this.torque.set(a[27], a[34], a[41])
    let utilization = 0
    const total = this.total.set(0, 0, 0),
      totalMoment = this.totalMoment.set(0, 0, 0),
      cross = this.cross
    for (let i = 0; i < this.cups.length; i++) {
      const cup = this.cups[i],
        force = this.forces[i]
      if (!this.active[i]) continue
      this.delta.copy(cup.anchor).sub(centre)
      force.crossVectors(rotation, this.delta).add(translation).multiplyScalar(cup.limit * cup.limit)
      const normal = force.dot(cup.normal),
        shear = Math.sqrt(Math.max(0, force.lengthSq() - normal * normal))
      utilization = Math.max(utilization, Math.hypot(Math.abs(normal), shear / cup.settings.friction) / cup.limit)
      total.add(force)
      totalMoment.add(cross.crossVectors(this.delta, force))
    }
    return this.finish(this.arms.size, total.distanceTo(load) + totalMoment.distanceTo(moment), utilization)
  }
}
