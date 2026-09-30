import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { COVE, bounded, radiusAt, straight, validateProfile } from '../src/sim/continuum/profile'
import { ArmKinematics, frame, sectionFrame } from '../src/sim/continuum/kinematics'

const section = COVE.arms[0].sections[0]

describe('continuum geometry', () => {
  it('names eight distinct chains, 32 sections and 128 contact elements without landmark or humanoid dependencies', () => {
    expect(new Set(COVE.arms.map((arm) => arm.id)).size).toBe(8)
    expect(new Set(COVE.arms.flatMap((arm) => arm.sections.map((s) => s.id))).size).toBe(32)
    expect(new Set(COVE.arms.flatMap((arm) => arm.cups.map((cup) => cup.id))).size).toBe(128)
    for (const arm of COVE.arms) expect(arm.sections.reduce((sum, s) => sum + s.length, 0)).toBeCloseTo(0.88)
  })
  it('has a continuous straight limit, including pure twist and infinitesimal curvature', () => {
    for (const k of [0, 1e-12, 1e-8, 1e-4]) {
      const out = sectionFrame(section, { kx: k, ky: -k, strain: 0.1, twist: 0 }, 1, frame())
      expect(out.position.distanceTo(new Vector3(0, 0, 0.242))).toBeLessThan(5e-6)
      expect(out.orientation.length()).toBeCloseTo(1, 12)
    }
    const twisted = sectionFrame(section, { ...straight(), twist: 0.8 }, 1, frame())
    expect(twisted.position.toArray()).toEqual([0, 0, 0.22])
    expect(twisted.orientation.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.176))).toBeLessThan(1e-7)
  })
  it('uses the right-handed tangent convention and exact circular arc', () => {
    const k = 3,
      x = sectionFrame(section, { ...straight(), ky: k }, 1, frame()),
      y = sectionFrame(section, { ...straight(), kx: k }, 1, frame())
    expect(x.position.x).toBeCloseTo((1 - Math.cos(k * section.length)) / k, 12)
    expect(x.position.z).toBeCloseTo(Math.sin(k * section.length) / k, 12)
    expect(y.position.y).toBeCloseTo(-x.position.x, 12)
    expect(new Vector3(0, 0, 1).applyQuaternion(x.orientation).x).toBeGreaterThan(0)
  })
  it('matches an independent small-step integration with coupled bend and twist', () => {
    const shape = { kx: 2.1, ky: -1.3, twist: 0.7, strain: 0.08 },
      analytic = sectionFrame(section, shape, 1, frame()),
      position = new Vector3(),
      orientation = new Quaternion(),
      omega = new Vector3(shape.kx, shape.ky, shape.twist),
      h = (section.length * (1 + shape.strain)) / 20000,
      rotation = new Quaternion().setFromAxisAngle(omega.clone().normalize(), omega.length() * h / 2),
      tangent = new Vector3()
    for (let i = 0; i < 20000; i++) {
      orientation.multiply(rotation)
      position.add(tangent.set(0, 0, h).applyQuaternion(orientation))
      orientation.multiply(rotation)
    }
    orientation.normalize()
    expect(analytic.position.distanceTo(position)).toBeLessThan(2e-6)
    expect(analytic.orientation.angleTo(orientation)).toBeLessThan(1e-6)
  })
  it.each([-0.1, 0, 0.05, 0.15])('conserves cross-section volume at strain %f', (strain) => {
    const radius = radiusAt(section, strain)
    expect(radius * radius * section.length * (1 + strain)).toBeCloseTo(section.radius ** 2 * section.length, 12)
  })
  it('caps combined bend angle and twist after elongation, and holds a finite shape for malformed targets', () => {
    const q = bounded(section, { kx: 100, ky: -100, strain: 4, twist: 20 }),
      length = section.length * (1 + q.strain)
    expect(Math.hypot(q.kx, q.ky) * length).toBeCloseTo(section.bend)
    expect(q.twist * length).toBeCloseTo(section.twist)
    expect(bounded(section, { kx: NaN, ky: Infinity, strain: NaN, twist: Infinity })).toEqual(straight())
  })
  it.each(COVE.arms)('$id keeps sample boundaries continuous and frames orthonormal across full sweeps', (arm) => {
    const fk = new ArmKinematics(arm),
      point = frame()
    for (let sweep = -10; sweep <= 10; sweep++) {
      const pose = arm.sections.map((s, i) => ({
        kx: (sweep / 10) * (s.bend / s.length) * Math.cos(i),
        ky: (sweep / 10) * (s.bend / s.length) * Math.sin(i),
        strain: (sweep / 10) * 0.1,
        twist: (sweep / 10) * (s.twist / s.length),
      }))
      const samples = fk.update(pose)
      expect(samples).toHaveLength(13)
      for (let i = 0; i < samples.length; i++) {
        expect(samples[i].orientation.length()).toBeCloseTo(1, 10)
        fk.at(i / 12, point)
        expect(point.position.distanceTo(samples[i].position)).toBeLessThan(1e-10)
        if (i > 0) expect(samples[i].position.distanceTo(samples[i - 1].position)).toBeLessThan(0.081)
      }
      for (let i = 1; i < 4; i++) {
        const left = fk.at(i / 4 - 1e-9, frame()),
          right = fk.at(i / 4 + 1e-9, frame())
        expect(left.position.distanceTo(right.position)).toBeLessThan(2e-9)
        expect(left.orientation.angleTo(right.orientation)).toBeLessThan(1e-6)
      }
    }
  })
  it('accepts a non-humanoid chain with unequal section lengths and samples by material distance', () => {
    const arm = { ...COVE.arms[0], position: new Vector3(), orientation: new Quaternion(),
      sections: [0.1, 0.3, 0.2].map((length, i) => ({ ...section, id: `probe.${i}`, length })) },
      fk = new ArmKinematics(arm)
    fk.update(arm.sections.map(straight))
    expect(fk.at(0.5, frame()).position.z).toBeCloseTo(0.3, 12)
    expect(fk.at(1, frame()).position.z).toBeCloseTo(0.6, 12)
  })
  it('refuses duplicate names, malformed roots and incompatible stroke/strain units', () => {
    expect(() => validateProfile({ ...COVE, arms: [COVE.arms[0], COVE.arms[0]], support: { ...COVE.support, minimumArms: 1 } })).toThrow()
    expect(() => new ArmKinematics({ ...COVE.arms[0], sections: [{ ...section, length: NaN }] })).toThrow()
    expect(() => new ArmKinematics({ ...COVE.arms[0], sections: [{ ...section, stroke: 0.001 }] })).toThrow()
    expect(() => validateProfile({ ...COVE, arms: [{ ...COVE.arms[0], orientation: new Quaternion(0, 0, 0, 0) }], support: { ...COVE.support, minimumArms: 1 } })).toThrow()
  })
})
