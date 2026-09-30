import { describe, expect, it } from 'vitest'
import { HUMANOID, KEEL, MORROW, neutral } from '../src/sim/humanoid/profile'
import { Tendons, fingerAngles, routePair, unroutePair } from '../src/sim/humanoid/tendons'

describe('sim tendon articulation', () => {
  it.each([KEEL, MORROW])('$id curls every phalange from one bounded tendon in the declared proportions', (profile) => {
    for (const curl of [0, 0.2, 0.5, 1])
      fingerAngles(profile, curl).forEach((angle, i) =>
        expect(angle).toBeCloseTo(profile.compliance!.fingers[i] * curl),
      )
    expect(fingerAngles(profile, -2)).toEqual([0, 0, 0])
    expect(fingerAngles(profile, 2)).toEqual([...profile.compliance!.fingers])
    expect(fingerAngles(profile, NaN)).toEqual([0, 0, 0])
  })
  it('differential tendon routing is reversible until shared travel saturates', () => {
    for (const a of [-0.4, 0, 0.4])
      for (const b of [-0.4, 0, 0.4]) {
        const q = unroutePair(...routePair(a, b, 1.3))
        expect(q[0]).toBeCloseTo(a)
        expect(q[1]).toBeCloseTo(b)
      }
    expect(unroutePair(...routePair(1, 1, 1.3))).toEqual([0.65, 0.65])
  })
  it.each([KEEL, MORROW])('$id settles with bounded overshoot and identical results at 30–120 Hz', (profile) => {
    const results: number[] = []
    for (const hz of [30, 60, 120]) {
      const tendons = new Tendons(profile),
        target = neutral(profile)
      target['left.arm.elbow'] = 1
      let max = 0
      for (let frame = 0; frame < hz * 2; frame++) {
        const q = tendons.step(target, { left: 1, right: 0 }, 1 / hz)
        max = Math.max(max, q['left.arm.elbow'])
        for (const joint of profile.joints) {
          expect(q[joint.id]).toBeGreaterThanOrEqual(joint.limits[0])
          expect(q[joint.id]).toBeLessThanOrEqual(joint.limits[1])
        }
      }
      expect(max).toBeLessThan(1.025)
      expect(tendons.grip.left).toBeCloseTo(1, 4)
      results.push(tendons.pose['left.arm.elbow'])
    }
    expect(results[0]).toBeCloseTo(1, 5)
    expect(results[0]).toBeCloseTo(results[1], 10)
    expect(results[1]).toBeCloseTo(results[2], 10)
  })
  it('routes wrist and ankle motion through shared tendon travel and stays inside angle limits', () => {
    const t = new Tendons(KEEL),
      q = neutral(KEEL)
    for (const route of t.routes)
      route.joints.forEach((id, i) => {
        q[id] = route.scales[i] * (i ? 1 : -1)
      })
    for (let n = 0; n < 240; n++) t.step(q, { left: 0, right: 0 }, 1 / 120)
    expect(t.routes).toHaveLength(4)
    for (const route of t.routes)
      route.joints.forEach((id, i) =>
        expect(t.pose[id]).toBeCloseTo(((route.scales[i] * route.travel) / 2) * (i ? 1 : -1), 4),
      )
  })
  it('a soft impact yields and settles without changing the commanded joint angles', () => {
    const t = new Tendons(KEEL),
      q = neutral(KEEL)
    t.step(q, { left: 0, right: 0 }, 1 / 60)
    t.contact('spine.pitch', 0.6)
    let max = 0
    for (let n = 0; n < 120; n++) max = Math.max(max, Math.abs(t.step(q, { left: 0, right: 0 }, 1 / 60)['spine.pitch']))
    expect(max).toBeGreaterThan(0.005)
    expect(max).toBeLessThan(0.03)
    expect(t.pose['spine.pitch']).toBeCloseTo(0, 5)
    expect(q['spine.pitch']).toBe(0)
  })
  it('reference driver profiles retain exact angle following without sim compliance', () => {
    const t = new Tendons(HUMANOID),
      q = neutral(HUMANOID)
    q['left.arm.elbow'] = 1
    expect(t.step(q, { left: 0, right: 0 }, 1 / 60)).toEqual(q)
    expect(t.routes).toHaveLength(0)
  })
  it('a fixed named distal axis does not create a non-finite tendon stroke', () => {
    const profile = {
        ...KEEL,
        joints: KEEL.joints.map((joint) =>
          joint.id === 'left.arm.wrist.roll' ? { ...joint, limits: [0, 0] as const } : joint,
        ),
      },
      t = new Tendons(profile),
      q = neutral(profile)
    q['left.arm.wrist.pitch'] = 0.4
    for (let frame = 0; frame < 120; frame++) t.step(q, { left: 0, right: 0 }, 1 / 60)
    expect(t.pose['left.arm.wrist.pitch']).toBeCloseTo(0.4, 5)
    expect(t.pose['left.arm.wrist.roll']).toBe(0)
  })
  it.each([30, 60, 120])('alternating full-range targets and impacts remain finite at %i Hz', (hz) => {
    const t = new Tendons(MORROW),
      q = neutral(MORROW)
    for (let frame = 0; frame < hz * 5; frame++) {
      for (const joint of MORROW.joints) q[joint.id] = joint.limits[Math.floor(frame / (hz / 4)) % 2]
      if (frame % hz === 0) t.contact('spine.pitch', -0.6)
      const pose = t.step(q, { left: +(frame % hz < hz / 2), right: 0 }, 1 / hz)
      for (const joint of MORROW.joints) {
        expect(Number.isFinite(pose[joint.id])).toBe(true)
        expect(pose[joint.id]).toBeGreaterThanOrEqual(joint.limits[0])
        expect(pose[joint.id]).toBeLessThanOrEqual(joint.limits[1])
      }
      expect(t.grip.left).toBeGreaterThanOrEqual(0)
      expect(t.grip.left).toBeLessThanOrEqual(1)
    }
  })
  it('invalid cadence holds the last finite pose and reset clears stored energy', () => {
    const t = new Tendons(KEEL),
      q = neutral(KEEL)
    q['left.arm.elbow'] = 1
    t.step(q, { left: 0, right: 0 }, 1 / 60)
    const before = { ...t.pose }
    expect(t.step(q, { left: NaN, right: 0 }, NaN)).toEqual(before)
    t.freeze()
    t.reset()
    expect(t.pose).toEqual(neutral(KEEL))
  })
})
