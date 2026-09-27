import { describe, expect, it } from 'vitest'
import { qAxisAngle, qMul } from '../packages/core/src/quat'
import { handMove, headingOf } from '../packages/host/src/hand'
import { ImuTracker } from '../src/controller/imu3d'

const D2R = Math.PI / 180

describe('3D from the phone’s own sensors (Wii-style: the gyro and an arm model, no camera)', () => {
  // A phone held upright facing the person, pointing its back toward the screen (−z).
  const upright = qAxisAngle(0, 1, 0, 0)

  it('swinging left moves the hand left, tipping up raises it, and turning back returns it', () => {
    const t = new ImuTracker()
    t.anchor(upright)
    expect(t.step(upright, null, null, 0.016)).toEqual([0, 0, 0])
    const heading = headingOf(upright)
    const left = handMove(t.step(qAxisAngle(0, 1, 0, 30 * D2R), null, null, 0.016), heading)
    expect(left.right).toBeCloseTo(-0.45 * Math.sin(30 * D2R), 3)
    const up = handMove(t.step(qAxisAngle(1, 0, 0, 20 * D2R), null, null, 0.016), heading)
    expect(up.up).toBeCloseTo(0.45 * Math.sin(20 * D2R), 3)
    expect(t.step(upright, null, null, 0.016)).toEqual([0, 0, 0])
  })

  it('pushes forward with the accelerometer, and stops drifting when the phone is still', () => {
    const t = new ImuTracker()
    t.anchor(upright)
    // 0.3 s pushing toward the screen (−z) at 2 m/s², then 0.3 s braking, then still.
    for (let i = 0; i < 18; i++) t.step(upright, [0, 0, -2], [0, 0, 0], 1 / 60)
    for (let i = 0; i < 18; i++) t.step(upright, [0, 0, 2], [0, 0, 0], 1 / 60)
    const pushed = handMove(t.step(upright, [0, 0, 0], [0, 0, 0], 1 / 60), 0).forward
    expect(pushed).toBeGreaterThan(0.1)
    let p = pushed
    for (let i = 0; i < 120; i++) p = handMove(t.step(upright, [0, 0, 0], [0, 0, 0], 1 / 60), 0).forward
    expect(Math.abs(p - pushed)).toBeLessThan(0.02)
  })

  it('reads a phone held flat like a remote by its top edge', () => {
    const flat = qMul(qAxisAngle(1, 0, 0, -90 * D2R), qAxisAngle(0, 0, 1, 0))
    const t = new ImuTracker()
    t.anchor(flat)
    const up = t.step(qMul(qAxisAngle(1, 0, 0, 20 * D2R), flat), null, null, 0.016)
    expect(up[1]).toBeGreaterThan(0.1)
  })
})
