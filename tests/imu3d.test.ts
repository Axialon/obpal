import { describe, expect, it } from 'vitest'
import { qAxisAngle, qMul } from '../packages/core/src/quat'
import { handMove, headingOf } from '../packages/host/src/hand'
import { ImuTracker } from '../src/controller/imu3d'
import { Tracker } from '../src/controller/track'

const D2R = Math.PI / 180

describe('3D from the phone’s own sensors (Wii-style: the gyro and an arm model, no camera)', () => {
  // A phone held upright facing the person, pointing its back toward the screen (−z).
  const upright = qAxisAngle(0, 1, 0, 0)

  it('estimates reach times the change in pointing direction even for rotation in place', () => {
    const t = new ImuTracker()
    t.reach = 0.6
    t.anchor(upright)
    // No translation or acceleration: a wrist turn still looks like an arm swing.
    const p = t.step(qAxisAngle(0, 1, 0, Math.PI / 2), [0, 0, 0], null, 1 / 60)
    expect(p[0]).toBeCloseTo(-0.6)
    expect(p[1]).toBe(0)
    expect(p[2]).toBeCloseTo(0.6)
  })

  it('cannot measure a sideways-only move with unchanged orientation', () => {
    const t = new ImuTracker()
    t.anchor(upright)
    // Accelerate sideways, brake, then rest. Only acceleration along the pointing axis contributes.
    for (const x of [2, -2, 0]) for (let i = 0; i < 30; i++) {
      expect(t.step(upright, [x, 0, 0], [0, 0, 0], 1 / 60)).toEqual([0, 0, 0])
    }
  })

  it('shares non-repeating origins between camera recentering and motion grabs', () => {
    let generation = 0
    const next = () => ++generation
    const camera = new Tracker(next), motion = new ImuTracker(next)
    const seen = new Set<number>()
    for (let i = 0; i < 260; i++) {
      camera.recenter()
      expect(seen.has(camera.gen)).toBe(false)
      seen.add(camera.gen)
      motion.anchor(upright)
      expect(seen.has(motion.gen)).toBe(false)
      seen.add(motion.gen)
      motion.release()
    }
  })

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
