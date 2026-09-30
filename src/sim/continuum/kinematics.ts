/** Exact section exponentials for the reduced PCC model; no interpolated hinge poses. */
import { Quaternion, Vector3 } from 'three'
import { bounded, clamp, finite, straight, validateSection, type ContinuumArm, type Section, type Shape } from './profile'

export interface Frame {
  position: Vector3
  orientation: Quaternion
}
export const frame = (): Frame => ({ position: new Vector3(), orientation: new Quaternion() })

/** Local +z is the tangent. The integral of exp([u]s) gives a continuous position at zero curvature and twist. */
export function sectionFrame(section: Section, shape: Shape, fraction: number, out: Frame): Frame {
  const strain = clamp(finite(shape.strain), ...section.strain),
    fullLength = section.length * (1 + strain),
    angle = Math.hypot(finite(shape.kx), finite(shape.ky)) * fullLength,
    scale = angle > section.bend ? section.bend / angle : 1,
    kx = finite(shape.kx) * scale,
    ky = finite(shape.ky) * scale,
    twist = clamp(finite(shape.twist), -section.twist / fullLength, section.twist / fullLength),
    length = fullLength * clamp(finite(fraction), 0, 1),
    w = Math.hypot(kx, ky, twist),
    theta = w * length,
    t2 = theta * theta
  let b: number, c: number, rotation: number
  if (Math.abs(theta) < 1e-4) {
    b = length * length * (0.5 - t2 / 24 + (t2 * t2) / 720)
    c = length * length * length * (1 / 6 - t2 / 120 + (t2 * t2) / 5040)
    rotation = length * (0.5 - t2 / 48 + (t2 * t2) / 3840)
  } else {
    b = (1 - Math.cos(theta)) / (w * w)
    c = (theta - Math.sin(theta)) / (w * w * w)
    rotation = Math.sin(theta / 2) / w
  }
  out.position.set(
    ky * b + kx * twist * c,
    -kx * b + ky * twist * c,
    length - (kx * kx + ky * ky) * c,
  )
  out.orientation.set(kx * rotation, ky * rotation, twist * rotation, Math.cos(theta / 2)).normalize()
  return out
}

/** Reusable sample frames are suitable for skinning, cup placement and collision capsules. */
export class ArmKinematics {
  readonly samples: Frame[]
  private local = frame()
  private base = frame()
  private shapes: Shape[]
  private lengths: number[]
  private zero = straight()
  constructor(readonly arm: ContinuumArm, readonly samplesPerSection = 3) {
    if (!Number.isInteger(samplesPerSection) || samplesPerSection < 1 || !arm.sections.length)
      throw new Error('Invalid arm sample count')
    arm.sections.forEach(validateSection)
    this.samples = Array.from({ length: arm.sections.length * samplesPerSection + 1 }, frame)
    this.shapes = arm.sections.map(straight)
    this.lengths = [0]
    for (const section of arm.sections) this.lengths.push(this.lengths[this.lengths.length - 1] + section.length)
    this.update(this.shapes)
  }
  update(shapes: readonly Shape[]) {
    this.base.position.copy(this.arm.position)
    this.base.orientation.copy(this.arm.orientation)
    this.samples[0].position.copy(this.base.position)
    this.samples[0].orientation.copy(this.base.orientation)
    for (let i = 0; i < this.arm.sections.length; i++) {
      const section = this.arm.sections[i]
      bounded(section, shapes[i] ?? this.zero, this.shapes[i])
      for (let n = 1; n <= this.samplesPerSection; n++) {
        const out = this.samples[i * this.samplesPerSection + n]
        sectionFrame(section, this.shapes[i], n / this.samplesPerSection, this.local)
        out.position.copy(this.local.position).applyQuaternion(this.base.orientation).add(this.base.position)
        out.orientation.copy(this.base.orientation).multiply(this.local.orientation)
      }
      const end = this.samples[(i + 1) * this.samplesPerSection]
      this.base.position.copy(end.position)
      this.base.orientation.copy(end.orientation)
    }
    return this.samples
  }
  /** Evaluate the analytic section at any material point, including the exact shared boundary. */
  at(fraction: number, out: Frame): Frame {
    const distance = clamp(finite(fraction), 0, 1) * this.lengths[this.lengths.length - 1]
    let index = 0
    while (index < this.arm.sections.length - 1 && this.lengths[index + 1] <= distance) index++
    const value = (distance - this.lengths[index]) / this.arm.sections[index].length,
      base = this.samples[index * this.samplesPerSection]
    sectionFrame(this.arm.sections[index], this.shapes[index], value, this.local)
    out.position.copy(this.local.position).applyQuaternion(base.orientation).add(base.position)
    out.orientation.copy(base.orientation).multiply(this.local.orientation)
    return out
  }
}
