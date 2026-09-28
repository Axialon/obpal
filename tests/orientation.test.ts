import { describe, expect, it } from 'vitest'
import { Euler, Quaternion, Vector3 } from 'three'
import { EARTH_TO_VIEW, OrientationReference, OrientationSmoother, phoneTiltAngles, poseRelativeInView, poseVectorInView, qAxisAngle, qConj, qIdentity, qMul, qRotate, quatFromDeviceOrientation, type Quat, type Vec3 } from '@obpal/core'

const D = Math.PI / 180
const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const axis = (i: number, d: number) => new Quaternion().setFromAxisAngle(new Vector3(...axes[i]), d * D)
const tuple = (q: Quaternion) => q.toArray() as Quat
const close = (a: Quat, b: Quat) => axes.forEach(v => qRotate(a, v).forEach((c, i) => expect(c).toBeCloseTo(qRotate(b, v)[i], 6)))
const reading = (q: Quaternion, screen: number) => {
  const e = new Euler().setFromQuaternion(q, 'ZXY')
  return quatFromDeviceOrientation(e.z / D, e.x / D, e.y / D, screen)
}

describe('W3C orientation in the camera frame', () => {
  for (const heading of [0, 137, 359]) for (const [hold, beta, screen] of [
    ['portrait', 60, 0], ['landscape left', 60, 90], ['landscape right', 60, 270], ['flat', 0, 0], ['upright', 90, 0],
  ] as const) for (const i of [0, 1, 2]) for (const deg of [-30, 30]) {
    it(`${hold}, heading ${heading}: axis ${i}, ${deg} degrees has unit gain and the physical direction`, () => {
      // These are physical world rotations, converted independently by three.js to W3C readings.
      const view = axis(2, heading).multiply(axis(0, 90))
      const neutral = axis(2, heading).multiply(axis(0, beta)).multiply(axis(2, screen))
      const moved = view.clone().multiply(axis(i, deg)).multiply(view.clone().invert()).multiply(neutral)
      const ref = new OrientationReference()
      ref.capture(reading(neutral, screen), screen)
      close(ref.relative(reading(moved, screen), screen), tuple(axis(i, deg)))
    })
  }

  it('relative iOS alpha and absolute Android alpha give the same turn', () => {
    const read = (offset: number) => {
      const r = new OrientationReference()
      r.capture(quatFromDeviceOrientation(offset, 70, 12))
      return r.relative(quatFromDeviceOrientation(offset + 25, 95, 18))
    }
    close(read(0), read(216))
  })

  it('crosses alpha zero without a full turn, then returns to neutral without drift', () => {
    const r = new OrientationReference()
    r.capture(quatFromDeviceOrientation(359, 90, 0))
    close(r.relative(quatFromDeviceOrientation(1, 90, 0)), qAxisAngle(0, 1, 0, 2 * D))
    for (let i = 0; i < 10000; i++) r.relative(quatFromDeviceOrientation(i % 360, 89.99, 0))
    close(r.relative(quatFromDeviceOrientation(359, 90, 0)), qIdentity())
  })

  it('keeps alpha wrap and equivalent Euler branches short for scalar dial consumers', () => {
    const r = new OrientationReference()
    r.capture(quatFromDeviceOrientation(359, 90, 0))
    const wrapped = r.relative(quatFromDeviceOrientation(1, 90, 0))
    expect(wrapped[3]).toBeGreaterThan(0)
    expect(2 * Math.atan2(wrapped[2], wrapped[3]) / D).toBeCloseTo(0)
    r.capture(quatFromDeviceOrientation(20, 89, 30))
    const equivalent = r.relative(quatFromDeviceOrientation(200, 91, -150))
    expect(equivalent[3]).toBeCloseTo(1)
    expect(2 * Math.atan2(equivalent[2], equivalent[3]) / D).toBeCloseTo(0)
  })

  it('equivalent Euler branches near upright have the same orientation', () => {
    for (const beta of [89.999, 90, 90.001]) {
      close(quatFromDeviceOrientation(20, beta, 30), quatFromDeviceOrientation(200, 180 - beta, -150))
    }
  })

  it('recenter establishes a fresh neutral and view without retaining filter state', () => {
    const r = new OrientationReference(), q = quatFromDeviceOrientation(123, 87, 23, 270)
    r.relative(quatFromDeviceOrientation(42, 20, 0))
    r.capture(q, 270)
    close(r.relative(q, 270), qIdentity())
    r.reset()
    close(r.relative(quatFromDeviceOrientation(315, -12, 82), 0), qIdentity())
  })

  it('screen changes re-express the neutral without a synthetic 90-degree turn', () => {
    const r = new OrientationReference()
    r.capture(quatFromDeviceOrientation(17, 60, 0), 0)
    const before = r.relative(quatFromDeviceOrientation(47, 70, 8), 0)
    for (const screen of [90, 270, 180, 0, -90]) close(r.relative(quatFromDeviceOrientation(47, 70, 8, screen), screen), before)
  })

  it('virtual rotation lock keeps the original screen axes while the viewport rotates', () => {
    const r = new OrientationReference(), neutral = quatFromDeviceOrientation(17, 60, 0)
    r.capture(neutral, 0)
    const physical = qMul(qAxisAngle(0, 0, 1, 30 * D), neutral)
    close(r.relative(physical, 0), qAxisAngle(0, 1, 0, 30 * D))
  })

  it('freezes first-person look while steering, then resumes without a jump or a changed view frame', () => {
    const r = new OrientationReference(), q0 = quatFromDeviceOrientation(17, 60, 0)
    r.capture(q0)
    const looked = r.relative(quatFromDeviceOrientation(42, 70, 8))
    const steering = quatFromDeviceOrientation(80, 25, -40, 90)
    r.hold(steering, 90)
    close(r.relative(steering, 90), looked)
    const next = qMul(qAxisAngle(0, 0, 1, 10 * D), steering)
    close(r.relative(next, 90), qMul(qAxisAngle(0, 1, 0, 10 * D), looked))
  })

  it('3D hand and W3C turn share one view frame at every hold', () => {
    for (const beta of [0, 15, 60, 90]) for (const screen of [0, 90, 270]) {
      const q0 = quatFromDeviceOrientation(137, beta, 0, screen)
      const q = qMul(qAxisAngle(0, 0, 1, 0.4), q0), ref = new OrientationReference()
      ref.capture(q0, screen)
      close(poseRelativeInView(qMul(EARTH_TO_VIEW, q0), qMul(EARTH_TO_VIEW, q)), ref.relative(q, screen))
    }
  })

  it('a hand displacement uses its captured heading, rather than the compass heading as camera right', () => {
    for (const heading of [0, 90, 137, 270]) {
      const q0 = qMul(EARTH_TO_VIEW, quatFromDeviceOrientation(heading, 60, 0))
      const right: Vec3 = [Math.cos(heading * D) * 0.2, 0.1, -Math.sin(heading * D) * 0.2]
      poseVectorInView(q0, right).forEach((v, n) => expect(v).toBeCloseTo([0.2, 0.1, 0][n]))
    }
  })

  it('tray steering ignores heading and stays continuous through the upright Euler branch', () => {
    const q0 = quatFromDeviceOrientation(20, 89, 0)
    expect(phoneTiltAngles(q0, quatFromDeviceOrientation(75, 89, 0))).toEqual(expect.arrayContaining([expect.closeTo(0, 8)]))
    expect(phoneTiltAngles(q0, quatFromDeviceOrientation(20, 91, 0))[1]).toBeCloseTo(2)
    const flat = qIdentity(), right = qAxisAngle(0, 1, 0, 20 * D)
    expect(phoneTiltAngles(flat, right)[0]).toBeCloseTo(20)
    expect(phoneTiltAngles(flat, qAxisAngle(1, 0, 0, 20 * D))[1]).toBeCloseTo(20)
  })
})

describe('orientation smoothing', () => {
  it('the 1:1 default has zero application lag, including stops and reversals', () => {
    const f = new OrientationSmoother()
    for (const deg of [0, 30, 30, -30, 90, 0]) close(f.filter(tuple(axis(1, deg)), 1 / 60), tuple(axis(1, deg)))
  })

  it('an optional smoothed step preserves its axis, never overshoots, and converges at any frame rate', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 1)
    for (const hz of [30, 60, 120]) {
      const f = new OrientationSmoother(0.04)
      f.filter(qIdentity(), 1 / hz)
      let previous = 1
      for (let i = 1; i <= hz; i++) {
        const v = f.filter(tuple(q), 1 / hz)
        const error = new Quaternion(...v).angleTo(q)
        expect(error).toBeLessThanOrEqual(previous + 1e-7)
        close(v, tuple(new Quaternion().slerp(q, 1 - Math.exp(-i / hz / 0.04))))
        previous = error
      }
      expect(previous).toBeLessThan(1e-6)
    }
  })

  it('uses the shortest arc across antipodal samples and resets on engagement', () => {
    const f = new OrientationSmoother(0.04), q = tuple(axis(2, 179))
    f.filter(q, 1 / 60)
    close(f.filter(q.map(v => -v) as Quat, 1 / 60), q)
    f.reset()
    close(f.filter(qConj(q), 1 / 60), qConj(q))
  })
})
