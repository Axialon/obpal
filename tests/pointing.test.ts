import { describe, expect, it } from 'vitest'
import { qAxisAngle, qIdentity, qMul, type Quat } from '@obpal/core'
import { WiiPointer } from '../src/controller/pointing'

const D = Math.PI / 180
// Earth frame: x east, y north, z up. Identity = flat, screen up, top edge pointing north (at the screen).
const turn = (deg: number, q: Quat) => qMul(qAxisAngle(0, 0, 1, deg * D), q) // about gravity; + = to the left
const raise = (deg: number, q: Quat) => qMul(qAxisAngle(1, 0, 0, deg * D), q) // about east; + = top edge up
const twist = (deg: number, q: Quat) => qMul(q, qAxisAngle(0, 1, 0, deg * D)) // about the phone's own long axis

/** Feed one pose long enough for the smoothing to settle; returns the accumulator. */
function settle(p: WiiPointer, q: Quat) {
  for (let i = 0; i < 400; i++) p.update(q, 1 / 60)
  return [p.acc[0], p.acc[1]]
}

describe('Wii-style pointing', () => {
  it('turning left and raising the phone move the aim left and up, by the angle turned', () => {
    const p = new WiiPointer()
    const q0 = qIdentity()
    p.recenter(q0)
    expect(settle(p, q0)).toEqual([0, 0])
    const [yaw] = settle(p, turn(10, q0))
    expect(yaw).toBeCloseTo(10, 2)
    expect(p.aim[0]).toBeCloseTo(-10, 2) // absolute: + = right
    const [, pitch] = settle(p, raise(5, q0))
    expect(pitch).toBeCloseTo(5, 2)
  })

  it('twisting the phone around the axis it points with does not move the cursor', () => {
    const p = new WiiPointer()
    const q0 = raise(40, qIdentity()) // screen tipped toward the face, as when holding a remote
    p.recenter(q0)
    settle(p, q0)
    const [yaw, pitch] = settle(p, twist(25, q0))
    expect(Math.abs(yaw)).toBeLessThan(1e-6)
    expect(Math.abs(pitch)).toBeLessThan(1e-6)
    // Turning about gravity from the tipped grip still reads as a plain left turn.
    const [yaw2, pitch2] = settle(p, turn(12, q0))
    expect(yaw2).toBeCloseTo(12, 2)
    expect(Math.abs(pitch2)).toBeLessThan(1e-6)
  })

  it('held upright like a camera, the back of the phone points', () => {
    const p = new WiiPointer()
    const q0 = raise(90, qIdentity()) // screen facing the user, top edge up
    p.recenter(q0)
    expect(p.pointingAxis).toEqual([0, 0, -1])
    settle(p, q0)
    const [yaw, pitch] = settle(p, turn(-8, q0))
    expect(yaw).toBeCloseTo(-8, 2)
    expect(Math.abs(pitch)).toBeLessThan(1e-6)
    expect(settle(p, raise(6, q0))[1]).toBeCloseTo(6, 2)
  })

  it('recentring never jumps the output, and later aim is relative to the new pose', () => {
    const p = new WiiPointer()
    p.recenter(qIdentity())
    const before = settle(p, turn(20, qIdentity()))
    p.recenter(turn(20, qIdentity()))
    expect(p.update(turn(20, qIdentity()), 1 / 60)).toEqual(before)
    expect(settle(p, turn(25, qIdentity()))[0]).toBeCloseTo(before[0] + 5, 2)
    expect(p.aim[0]).toBeCloseTo(-5, 2)
  })

  it('keeps counting through a full turn instead of wrapping back', () => {
    const p = new WiiPointer()
    p.recenter(qIdentity())
    for (let a = 0; a <= 200; a += 5) settle(p, turn(a, qIdentity()))
    expect(p.acc[0]).toBeCloseTo(200, 1)
  })
})
