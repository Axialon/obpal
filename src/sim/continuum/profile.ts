/** Named continuum chains. Dimensions and limits are original simulation choices, not hardware specifications. */
import { Quaternion, Vector3 } from 'three'

export interface Shape {
  kx: number
  ky: number
  strain: number
  twist: number
}
export interface Section {
  id: string
  length: number
  radius: number
  routeRadius: number
  stroke: number
  strokeRate: number
  bend: number
  twist: number
  strain: readonly [number, number]
}
export interface CupSite {
  id: string
  arm: string
  fraction: number
  row: number
  radius: number
}
export interface ContinuumArm {
  id: string
  position: Vector3
  orientation: Quaternion
  sections: readonly Section[]
  cups: readonly CupSite[]
}
export interface ContinuumProfile {
  id: string
  arms: readonly ContinuumArm[]
  elasticity: { stiffness: number; airDamping: number; waterDamping: number }
  suction: {
    pressure: number
    sealTime: number
    releaseTime: number
    stiffness: number
    damping: number
    stretch: number
    friction: number
  }
  support: { minimumArms: number; margin: number }
}

export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
export const finite = (x: number, fallback = 0) => (Number.isFinite(x) ? x : fallback)
export const straight = (): Shape => ({ kx: 0, ky: 0, strain: 0, twist: 0 })

/** Bound angle by the actual elongated length, rather than independently clipping bend axes. */
export function bounded(section: Section, value: Shape, out: Shape = straight()): Shape {
  out.strain = clamp(finite(value.strain), ...section.strain)
  out.kx = finite(value.kx)
  out.ky = finite(value.ky)
  const length = section.length * (1 + out.strain),
    bend = Math.hypot(out.kx, out.ky) * length
  if (bend > section.bend) {
    out.kx *= section.bend / bend
    out.ky *= section.bend / bend
  }
  out.twist = clamp(finite(value.twist), -section.twist / length, section.twist / length)
  return out
}

/** Constant tissue volume couples elongation to narrowing. */
export function radiusAt(section: Section, strain: number) {
  return section.radius / Math.sqrt(1 + clamp(finite(strain), ...section.strain))
}

export function validateSection(section: Section) {
  const positive = [section.length, section.radius, section.routeRadius, section.stroke, section.strokeRate],
    nonnegative = [section.bend, section.twist]
  if (!section.id || positive.some((n) => !Number.isFinite(n) || n <= 0) ||
    nonnegative.some((n) => !Number.isFinite(n) || n < 0) || section.routeRadius > section.radius ||
    !section.strain.every(Number.isFinite) || section.strain[0] <= -1 || section.strain[0] > 0 || section.strain[1] < 0 ||
    section.stroke < section.length * Math.max(...section.strain.map(Math.abs)))
    throw new Error('Invalid continuum section')
}

/** Profiles are data, but invalid units or duplicate names must fail before any integration or later adapter mapping. */
export function validateProfile(profile: ContinuumProfile) {
  const names = new Set<string>()
  const name = (id: string) => {
    if (!id || names.has(id)) throw new Error('Duplicate or empty continuum name')
    names.add(id)
  }
  if (!profile.id || !profile.arms.length ||
    !Object.values(profile.elasticity).every((n) => Number.isFinite(n) && n > 0) ||
    !Object.values(profile.suction).every((n) => Number.isFinite(n) && n > 0) ||
    !Number.isInteger(profile.support.minimumArms) || profile.support.minimumArms < 1 ||
    profile.support.minimumArms > profile.arms.length || !(profile.support.margin >= 1))
    throw new Error('Invalid continuum profile')
  for (const arm of profile.arms) {
    name(arm.id)
    if (!arm.sections.length || !arm.position.toArray().every(Number.isFinite) ||
      !arm.orientation.toArray().every(Number.isFinite) || Math.abs(arm.orientation.lengthSq() - 1) > 1e-6)
      throw new Error('Invalid continuum root')
    for (const section of arm.sections) {
      name(section.id)
      validateSection(section)
    }
    for (const cup of arm.cups) {
      name(cup.id)
      if (cup.arm !== arm.id || !Number.isFinite(cup.fraction) || cup.fraction < 0 || cup.fraction > 1 ||
        !Number.isFinite(cup.radius) || cup.radius <= 0) throw new Error('Invalid sucker site')
    }
  }
  return profile
}

const radians = (x: number) => (x * Math.PI) / 180
const arms: ContinuumArm[] = []
for (const side of [-1, 1]) {
  for (let n = 0; n < 4; n++) {
    const angle = radians(side * (22.5 + n * 45)),
      id = `${side < 0 ? 'L' : 'R'}${n + 1}`,
      direction = new Vector3(Math.sin(angle), -0.15, Math.cos(angle)).normalize()
    arms.push({
      id,
      position: new Vector3(Math.sin(angle) * 0.19, 0, Math.cos(angle) * 0.19),
      orientation: new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), direction),
      sections: Array.from({ length: 4 }, (_, i) => ({
        id: `${id}.s${i + 1}`,
        length: 0.22,
        radius: 0.055 - (i * 0.044) / 3,
        routeRadius: 0.8 * (0.055 - (i * 0.044) / 3),
        stroke: 0.065,
        strokeRate: 0.25,
        bend: radians(75),
        twist: radians(20),
        strain: [-0.1, 0.15] as const,
      })),
      cups: Array.from({ length: 16 }, (_, i) => ({
        id: `${id}.cup${i + 1}`,
        arm: id,
        fraction: 0.12 + (Math.floor(i / 2) * 0.83) / 7,
        row: i % 2 ? 1 : -1,
        radius: 0.018 - (Math.floor(i / 2) * 0.012) / 7,
      })),
    })
  }
}

/** Four arms reserve distributed support while another arm peels. Capacity and moment checks remain mandatory. */
export const COVE: ContinuumProfile = {
  id: 'cove',
  arms,
  elasticity: { stiffness: 196, airDamping: 24, waterDamping: 34 },
  suction: {
    pressure: 18000,
    sealTime: 0.12,
    releaseTime: 0.09,
    stiffness: 1800,
    damping: 28,
    stretch: 0.04,
    friction: 0.8,
  },
  support: { minimumArms: 4, margin: 1.5 },
}
validateProfile(COVE)
