import { describe, expect, it } from 'vitest'
import { ALL_PHYSICAL_PROFILES, buildHumanoid } from '../src/sim/humanoid/physics/model'
import { observe, type Observation } from '../src/sim/humanoid/physics/observation'
import { supportHull, shrinkPolygon, polygonCentroid, polygonMargin, projectToPolygon, capturePoint, captureState,
  advanceStepTrigger, chooseSwingFoot, landingTarget, type CaptureState, type LandingInput, type FootSide } from '../src/sim/humanoid/physics/stepping'
import { ZERO, add, rotate, fromRotationVector, type Vec3 } from '../src/sim/physics/math'

const p = (x: number, z: number, y = 0): Vec3 => ({ x, y, z })
const square = [p(-.2, -.2), p(.2, -.2), p(.2, .2), p(-.2, .2)]
function vector(actual: Vec3, expected: Vec3) {
  for (const axis of ['x', 'y', 'z'] as const) expect(actual[axis]).toBeCloseTo(expected[axis], 10)
}
function observation(): Observation {
  const model = buildHumanoid('keel-v1'), o = observe(model, model.scene.bodies.map(b => ({ ...b, sleeping: false })), [], 1, 0)
  o.com = p(0, 0, 1); o.comVelocity = { ...ZERO }
  o.support = { polygon: structuredClone(square), points: structuredClone(square), normalImpulseNs: 4, marginM: .2 }
  o.feet.forEach((f, i) => { f.normalImpulseNs = i ? 3 : 1; f.centreOfPressure = p(i ? .1 : -.1, 0) })
  return o
}
function capture(x = 0, z = 0, speedMps = 0): CaptureState {
  const state = captureState(observation())!, point = p(x, z)
  return { ...state, point, speedMps, marginM: polygonMargin(state.polygon, point) }
}
const landing: LandingInput = { capturePoint: p(-.1, -.1), cop: { ...ZERO }, omega: Math.log(2) / .32,
  stanceAnkle: p(.1, 0), swing: 'left', yawRad: 0, hipHeightM: 1, exitDirection: p(0, -1) }

describe('capture support geometry', () => {
  it('takes a convex hull of unordered measured contacts without changing them', () => {
    const points = [square[2], p(0, 0), square[0], square[3], square[1], square[0]], before = structuredClone(points)
    expect(supportHull(points)).toEqual(square)
    expect(points).toEqual(before)
    expect(supportHull([p(-1, 0), p(0, 0), p(1, 0)])).toEqual([p(-1, 0), p(1, 0)])
  })
  it('shrinks every real triangle edge instead of its axis-aligned bounding box', () => {
    const triangle = [p(0, 0), p(1, 0), p(0, 1)], shrunk = shrinkPolygon(triangle, .1)
    expect(shrunk).toHaveLength(3)
    for (const expected of [p(.1, .1), p(.9 - Math.SQRT2 * .1, .1), p(.1, .9 - Math.SQRT2 * .1)])
      expect(Math.min(...shrunk.map(q => Math.hypot(q.x - expected.x, q.z - expected.z)))).toBeLessThan(1e-10)
    expect(polygonMargin(shrunk, p(.7, .7))).toBeLessThan(0)
    for (const point of shrunk) expect(polygonMargin(triangle, point)).toBeCloseTo(.1, 10)
  })
  it('keeps a true edge inset under yaw, translation, clockwise winding and duplicate points', () => {
    const yaw = fromRotationVector(p(0, 0, .73)), shift = p(2, -3, .4), transform = (q: Vec3) => add(shift, rotate(yaw, q))
    const expected = shrinkPolygon(square, .02).map(transform)
    const actual = shrinkPolygon([...square, square[0]].reverse().map(transform), .02)
    expect(actual).toHaveLength(4)
    for (const point of actual) expect(Math.min(...expected.map(q => Math.hypot(q.x - point.x, q.z - point.z)))).toBeLessThan(1e-10)
    vector(polygonCentroid(actual)!, shift)
  })
  it('returns no area when an inset collapses or removes the contact polygon', () => {
    for (const inset of [.2, .21, 2]) expect(shrinkPolygon(square, inset)).toEqual([])
    expect(shrinkPolygon([p(-1, 0), p(1, 0)], .01)).toEqual([])
    expect(shrinkPolygon(square, 0)).toEqual(square)
    expect(polygonMargin([], ZERO)).toBeNull()
    expect(polygonCentroid([p(0, 0)])).toBeNull()
    expect(projectToPolygon([], ZERO)).toBeNull()
  })
  it('uses the area centroid rather than averaging unequal polygon vertices', () => {
    vector(polygonCentroid([p(0, 0), p(4, 0), p(2, 2), p(0, 2)])!, p(14 / 9, 8 / 9))
  })
  it('projects to edges and corners and preserves inside points horizontally', () => {
    vector(projectToPolygon(square, p(.5, .05))!, p(.2, .05))
    vector(projectToPolygon(square, p(.5, .5))!, p(.2, .2))
    vector(projectToPolygon(square, p(.1, -.05, 4))!, p(.1, -.05))
    expect(polygonMargin(square, p(0, 0))).toBeCloseTo(.2)
    expect(polygonMargin(square, p(.2, 0))).toBe(0)
    expect(polygonMargin(square, p(.3, 0))).toBeCloseTo(-.1)
  })
  it('rejects invalid geometry and insets', () => {
    expect(() => supportHull([p(NaN, 0)])).toThrow()
    expect(() => polygonMargin(square, p(0, Infinity))).toThrow()
    for (const inset of [-.01, NaN, Infinity]) expect(() => shrinkPolygon(square, inset)).toThrow()
  })
})

describe('capture state and step trigger', () => {
  it('uses height above COP and horizontal COM velocity in metres and seconds', () => {
    const result = capturePoint(p(1, 2, 1.25), p(.6, -.3, 20), p(0, 0, .25), 9)!
    expect(result.heightM).toBe(1)
    expect(result.omega).toBe(3)
    vector(result.point, p(1.2, 1.9, .25))
  })
  it('is invariant to world translation and equivariant to yaw', () => {
    const com = p(.1, -.2, 1), velocity = p(.3, -.1), cop = p(0, 0), yaw = fromRotationVector(p(0, 0, .7)), shift = p(2, -3, .4)
    const transform = (q: Vec3) => add(shift, rotate(yaw, q)), result = capturePoint(com, velocity, cop)!
    vector(capturePoint(transform(com), rotate(yaw, velocity), transform(cop))!.point, transform(result.point))
  })
  it('requires positive height and finite gravity and observations', () => {
    expect(capturePoint(ZERO, ZERO, ZERO)).toBeNull()
    expect(capturePoint(p(0, 0, -1), ZERO, ZERO)).toBeNull()
    expect(capturePoint(p(0, 0, 1), p(NaN, 0), ZERO)).toBeNull()
    expect(capturePoint(p(Number.MAX_VALUE, 0, 1), p(Number.MAX_VALUE, 0), ZERO, .01)).toBeNull()
    expect(capturePoint(p(0, 0, Number.MIN_VALUE), ZERO, ZERO)).toBeNull()
    for (const gravity of [0, -1, NaN, Infinity]) expect(capturePoint(p(0, 0, 1), ZERO, ZERO, gravity)).toBeNull()
  })
  it('uses load-weighted measured COP, a 2 cm inset and the original hull centroid', () => {
    const o = observation(), before = structuredClone(o), result = captureState(o)!
    vector(result.cop, p(.05, 0))
    vector(result.centroid, ZERO)
    expect(result.heightM).toBe(1)
    expect(result.marginM).toBeCloseTo(.18)
    expect(result.polygon).toEqual(shrinkPolygon(square, .02))
    expect(o).toEqual(before)
    o.feet.forEach(f => { f.normalImpulseNs = 0 })
    expect(captureState(o)).toBeNull()
  })
  it('keeps measured capture with edge or point support without fabricating a polygon', () => {
    for (const polygon of [[p(-.1, 0), p(.1, 0)], [p(.05, 0)]]) {
      const o = observation(); o.support.polygon = polygon
      const result = captureState(o)!
      expect(result).not.toBeNull()
      expect(result.polygon).toEqual([])
      expect(result.marginM).toBeNull()
      vector(result.centroid, result.cop)
      expect(advanceStepTrigger(advanceStepTrigger(null, result, 0), result, 1).triggered).toBe(true)
    }
  })
  it('rejects inconsistent measured loads and pressure centres rather than dropping them', () => {
    for (const load of [-1, NaN, Infinity]) {
      const o = observation(); o.feet[0].normalImpulseNs = load
      expect(captureState(o)).toBeNull()
    }
    for (const cop of [null, p(NaN, 0)]) {
      const o = observation(); o.feet[0].centreOfPressure = cop
      expect(captureState(o)).toBeNull()
    }
    const o = observation(); o.feet.forEach(f => { f.normalImpulseNs = Number.MAX_VALUE })
    expect(captureState(o)).toBeNull()
  })
  it.each(ALL_PHYSICAL_PROFILES)('%s computes capture from the authored free-body COM', profile => {
    const model = buildHumanoid(profile), o = observe(model, model.scene.bodies.map(b => ({ ...b, sleeping: false })), [], 1, 0)
    const result = capturePoint(o.com, p(0, -.2), ZERO)!
    expect(result.heightM).toBeGreaterThan(.8)
    expect(result.heightM).toBeLessThan(1)
    expect(result.omega ** 2 * result.heightM).toBeCloseTo(9.81, 12)
    expect(result.point.z).toBeLessThan(o.com.z)
    vector(capturePoint(o.com, ZERO, ZERO)!.point, { ...o.com, y: 0 })
  })
  it('requires two consecutive outside ticks and never counts the same observation twice', () => {
    const state = capture(.22, 0), first = advanceStepTrigger(null, state, 10)
    expect(first).toMatchObject({ outsideTicks: 1, triggered: false, reason: null })
    expect(advanceStepTrigger(first, state, 10)).toEqual(first)
    expect(advanceStepTrigger(first, state, 11)).toMatchObject({ outsideTicks: 2, triggered: true, reason: 'capture' })
    expect(advanceStepTrigger(first, state, 12)).toMatchObject({ outsideTicks: 1, triggered: false })
    expect(advanceStepTrigger(first, state, 9)).toMatchObject({ outsideTicks: 1, triggered: false })
  })
  it('resets persistence on return to support or loss of usable capture state', () => {
    const outside = capture(0, -.22), first = advanceStepTrigger(null, outside, 0)
    const inside = advanceStepTrigger(first, capture(), 1)
    expect(inside.outsideTicks).toBe(0)
    expect(advanceStepTrigger(inside, outside, 2).triggered).toBe(false)
    expect(advanceStepTrigger(first, null, 1)).toMatchObject({ outsideTicks: 0, triggered: false })
    expect(() => advanceStepTrigger(null, outside, -.5)).toThrow()
  })
  it('triggers immediately above 0.35 m/s and uses Euclidean distance at support corners', () => {
    expect(advanceStepTrigger(null, capture(0, 0, .35001), 0)).toMatchObject({ triggered: true, reason: 'speed' })
    expect(advanceStepTrigger(null, capture(0, 0, .35), 0).triggered).toBe(false)
    const diagonal = capture(.205, .205), first = advanceStepTrigger(null, diagonal, 0)
    expect(diagonal.marginM).toBeCloseTo(-.025)
    expect(advanceStepTrigger(first, diagonal, 1).triggered).toBe(true) // sqrt(2) * .025 > .03.
    const close = capture(.209, 0)
    expect(advanceStepTrigger(advanceStepTrigger(null, close, 0), close, 1).triggered).toBe(false)
  })
})

describe('load-aware recovery placement', () => {
  it('chooses the less-loaded foot for sagittal exits and uses a stable tie break', () => {
    expect(chooseSwingFoot({ left: 1, right: 3 }, p(0, -1), 0)).toBe('left')
    expect(chooseSwingFoot({ left: 3, right: 1 }, p(0, 1), 0)).toBe('right')
    expect(chooseSwingFoot({ left: 1, right: 1 }, p(0, -1), 0)).toBe('left')
    expect(chooseSwingFoot({ left: 0, right: 0 }, p(0, -1), 0)).toBeNull()
  })
  it('waits to unload the exit-side foot instead of requesting a crossing step', () => {
    expect(chooseSwingFoot({ left: 7, right: 3 }, p(-1, 0), 0)).toBeNull()
    expect(chooseSwingFoot({ left: 6, right: 4 }, p(-1, 0), 0)).toBe('left')
    expect(chooseSwingFoot({ left: 4, right: 6 }, p(1, -.4), 0)).toBe('right')
    expect(chooseSwingFoot({ left: 3, right: 7 }, p(1, 0), 0)).toBeNull()
  })
  it('keeps anatomical swing-side selection under yaw', () => {
    const yaw = .73, rotation = fromRotationVector(p(0, 0, yaw))
    expect(chooseSwingFoot({ left: 4, right: 6 }, rotate(rotation, p(-1, -.2)), yaw)).toBe('left')
    expect(chooseSwingFoot({ left: 7, right: 3 }, rotate(rotation, p(0, -1)), yaw)).toBe('right')
  })
  it('predicts exponential capture growth and adds 3 cm along a normalized exit', () => {
    const result = landingTarget({ ...landing, exitDirection: p(0, -10) })
    vector(result.predicted, p(-.2, -.23))
    vector(result.point, result.predicted)
    expect(result.capped).toBe(false)
    vector(landingTarget({ ...landing, exitDirection: ZERO }).predicted, p(-.2, -.2))
  })
  it.each(['left', 'right'] as const)('keeps every %s landing outside the stance leg and inside 0.6 L', swing => {
    for (const x of [-2, -.1, 0, .1, 2]) for (const z of [-2, 0, 2]) {
      const result = landingTarget({ ...landing, swing, capturePoint: p(x, z) }), dx = result.point.x - landing.stanceAnkle.x
      expect((swing === 'left' ? -1 : 1) * dx).toBeGreaterThanOrEqual(.2 - 1e-10)
      expect(Math.hypot(dx, result.point.z - landing.stanceAnkle.z)).toBeLessThanOrEqual(.6 + 1e-10)
      expect(result.point.y).toBe(landing.cop.y)
    }
  })
  it('reserves lateral width even when the forward reach cap is saturated', () => {
    const result = landingTarget({ ...landing, capturePoint: p(.1, -10) })
    expect(result.capped).toBe(true)
    expect(result.point.x).toBeCloseTo(-.1)
    expect(result.point.z).toBeCloseTo(-Math.sqrt(.6 ** 2 - .2 ** 2))
  })
  it('rotates and translates landing constraints with the actor heading', () => {
    const yaw = .73, rotation = fromRotationVector(p(0, 0, yaw)), shift = p(3, -4, .2)
    const transform = (point: Vec3) => add(shift, rotate(rotation, point)), before = { ...landing, capturePoint: p(2, -4) }
    const result = landingTarget({ ...before, capturePoint: transform(before.capturePoint), cop: transform(before.cop),
      stanceAnkle: transform(before.stanceAnkle), exitDirection: rotate(rotation, before.exitDirection), yawRad: yaw })
    vector(result.point, transform(landingTarget(before).point))
    vector(result.predicted, transform(landingTarget(before).predicted))
  })
  it('can recompute a capped landing from the new stance at touchdown without hidden state', () => {
    const input = { ...landing, capturePoint: p(0, -2) }, before = structuredClone(input), first = landingTarget(input)
    const next = landingTarget({ ...input, stanceAnkle: first.point, swing: 'right' })
    expect(first.capped).toBe(true)
    expect(next.point.z).toBeLessThan(first.point.z)
    expect(input).toEqual(before)
    expect(landingTarget(input)).toEqual(first)
  })
  it('rejects invalid load, impossible geometry and nonfinite capture predictions', () => {
    expect(() => chooseSwingFoot({ left: -1, right: 1 }, ZERO, 0)).toThrow()
    expect(() => chooseSwingFoot({ left: 1, right: 1 }, ZERO, NaN)).toThrow()
    expect(() => chooseSwingFoot({ left: Number.MAX_VALUE, right: Number.MAX_VALUE }, ZERO, 0)).toThrow()
    expect(() => landingTarget({ ...landing, hipHeightM: .2 })).toThrow()
    expect(() => landingTarget({ ...landing, omega: 0 })).toThrow()
    expect(() => landingTarget({ ...landing, omega: 10000 })).toThrow()
    expect(() => landingTarget({ ...landing, swing: 'other' as FootSide })).toThrow()
  })
})
