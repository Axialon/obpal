import { describe, expect, it } from 'vitest'
import { STEP } from '../src/sim/physics/schema'
import { add, sub, scale, cross, rotate, fromRotationVector, ZERO } from '../src/sim/physics/math'
import { buildHumanoid } from '../src/sim/humanoid/physics/model'
import { observe } from '../src/sim/humanoid/physics/observation'
import { contactSink, sinkSafeDiamond, SinkSafeSupport, sinkSafeAnkleMoment, conformAnkleMoment, polygonMargin } from '../src/sim/humanoid/physics/stepping'

describe('sink-safe sole control', () => {
  const model = buildHumanoid('keel-v1'), foot = model.scene.bodies.find(b => b.id === model.feet[0])!
  it('predicts load-linear sink from the declared principal moments', () => {
    const result = contactSink(foot, 59.5 * 9.81), double = contactSink(foot, 119 * 9.81)
    expect(result.centredSinkM).toBeGreaterThan(0)
    expect(double.centredSinkM).toBeCloseTo(2 * result.centredSinkM, 12)
    expect(result.stiffnessNpm).toBe(double.stiffnessNpm)
    expect(contactSink(foot, 0).centredSinkM).toBe(0)
    for (const invalid of [-1, NaN, Infinity]) expect(() => contactSink(foot, invalid)).toThrow()
  })
  it('bounds the analytic deepest corner and never allows an unloaded corner', () => {
    for (const load of [100, 300, 590, 900]) {
      const diamond = sinkSafeDiamond(foot, load)
      expect(diamond.rho).toBeGreaterThanOrEqual(0)
      expect(diamond.rho).toBeLessThanOrEqual(.85)
      if (diamond.centredSinkM <= .004) expect(diamond.centredSinkM * (1 + diamond.rho)).toBeLessThanOrEqual(.004 + 1e-12)
    }
    expect(sinkSafeDiamond(foot, 1e6).rho).toBe(0)
  })
  it('rotates and translates the diamond with the measured foot', () => {
    const rotation = fromRotationVector({ x: 0, y: .7, z: 0 }), shift = { x: 2, y: .3, z: -1 }
    const before = sinkSafeDiamond({ ...foot, position: ZERO }, 500)
    const after = sinkSafeDiamond({ ...foot, rotation, position: shift }, 500)
    for (const p of before.points) {
      const expected = add(shift, rotate(rotation, p))
      expect(Math.min(...after.points.map(q => Math.hypot(q.x - expected.x, q.y - expected.y, q.z - expected.z)))).toBeLessThan(1e-10)
    }
  })
  it('clips horizontal moments with the ankle height and leaves a measurable residual', () => {
    const safe = { ...sinkSafeDiamond(foot, 500), normalForceN: 500, id: foot.id, trim: 1, deepestM: .002,
      tiltRad: 0, contactSeconds: 1, contactBlend: 1, lateConform: false, measuredCop: foot.position }
    const anchor = add(safe.centre, { x: 0, y: .1, z: .02 }), force = { x: 15, y: 500, z: -10 }
    const farCOP = add(safe.centre, { x: .3, y: 0, z: -.5 }), requested = scale(cross(sub(farCOP, anchor), force), -1)
    const result = sinkSafeAnkleMoment(safe, anchor, force, requested)
    expect(polygonMargin(safe.points, result.cop)).toBeGreaterThanOrEqual(-1e-12)
    const expected = scale(cross(sub(result.cop, anchor), force), -1)
    expect(result.moment.x).toBeCloseTo(expected.x, 12)
    expect(result.moment.z).toBeCloseTo(expected.z, 12)
    expect(add(result.moment, result.residual)).toEqual(requested)
    expect(Math.hypot(result.residual.x, result.residual.z)).toBeGreaterThan(1)
  })
  it('trims from observation once per tick and restores more slowly without changing observations', () => {
    const controller = new SinkSafeSupport(model.scene.bodies, model.feet)
    const o = observe(model, model.scene.bodies.map(b => ({ ...b, sleeping: false })), [], 1, 0)
    o.feet.forEach(f => { f.normalImpulseNs = 300 * STEP; f.minSoleY = -.004 })
    const before = structuredClone(o), first = controller.update(o)
    expect(first[0].trim).toBeLessThan(1)
    expect(controller.update(o)).toEqual(first)
    expect(o).toEqual(before)
    const next = controller.update({ ...o, stateTick: 1 })
    expect(next[0].trim).toBeLessThan(first[0].trim)
    const restored = controller.update({ ...o, stateTick: 2, feet: o.feet.map(f => ({ ...f, minSoleY: -.001 })) })
    expect(restored[0].trim).toBeGreaterThan(next[0].trim)
    expect(restored[0].trim - next[0].trim).toBeLessThan(first[0].trim - next[0].trim)
    const unloaded = controller.update({ ...o, stateTick: 3, feet: o.feet.map(f => ({ ...f, normalImpulseNs: 0 })) })
    expect(unloaded).toEqual([])
  })
  it('keeps an edge landing in zero-moment conform until a flat two-dimensional support is measured', () => {
    const controller = new SinkSafeSupport(model.scene.bodies, model.feet)
    const o = observe(model, model.scene.bodies.map(b => ({ ...b, sleeping: false })), [], 1, 0)
    const measured = o.feet[0]
    measured.normalImpulseNs = 500 * STEP; measured.minSoleY = -.002
    measured.contactPoints = [{ x: 0, y: 0, z: 0 }, { x: .1, y: 0, z: 0 }, { x: .2, y: 0, z: 0 }]
    for (let tick = 0; tick <= 20; tick++) {
      const support = controller.update({ ...o, stateTick: tick })[0]
      expect(support.contactBlend).toBe(0)
      expect(Object.values(conformAnkleMoment(support, foot.position, { x: 10, y: 2, z: -4 })).every(value => value === 0)).toBe(true)
      expect(support.lateConform).toBe(tick * STEP >= .08)
    }
    measured.contactPoints.push({ x: .1, y: 0, z: .1 })
    for (let tick = 21; tick <= 36; tick++) {
      const support = controller.update({ ...o, stateTick: tick })[0]
      expect(support.contactBlend).toBeCloseTo(Math.min(1, (tick - 21) * STEP / .06), 12)
      expect(support.lateConform).toBe(false)
    }
  })
})
