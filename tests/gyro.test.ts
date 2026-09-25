import { describe, expect, it } from 'vitest'
import { GyroSmoother, playerSpaceRates, TiltStick } from '../src/controller/gyro'

const R = 180 / Math.PI

describe('player-space gyro (game-controller aiming)', () => {
  it('turning left is +yaw whether the phone is flat or upright', () => {
    expect(playerSpaceRates([0, 0, 1], [0, 0, 1])[0]).toBeCloseTo(R, 3) // flat, screen up
    expect(playerSpaceRates([0, 1, 0], [0, 1, 0])[0]).toBeCloseTo(R, 3) // upright, facing the user
    const t = Math.SQRT1_2 // tilted 45 degrees toward the user
    expect(playerSpaceRates([0, t, t], [0, t, t])[0]).toBeCloseTo(R, 3)
  })

  it('tilting the top edge up is +pitch; rolling the phone does not move yaw much', () => {
    expect(playerSpaceRates([1, 0, 0], [0, 0, 1])[1]).toBeCloseTo(R, 3)
    expect(Math.abs(playerSpaceRates([0, 1, 0], [0, 0, 1])[0])).toBeLessThan(0.01) // roll about the top edge when flat
  })

  it('smoother passes deliberate motion through and damps tremor at rest', () => {
    const s = new GyroSmoother(8, 1.2)
    for (let i = 0; i < 10; i++) s.apply(60, 0)
    expect(s.apply(60, 0)[0]).toBeCloseTo(60, 5)
    const r = new GyroSmoother(8, 1.2)
    let out = 0
    for (let i = 0; i < 30; i++) out = r.apply(i % 2 ? 0.5 : -0.5, 0)[0]
    expect(Math.abs(out)).toBeLessThan(0.2)
  })
})

describe('any grip: landscape and rotation-locked phones', () => {
  it('held sideways (top edge pointing left) with the screen still portrait', () => {
    const up: [number, number, number] = [1, 0, 0] // device x axis is now vertical
    expect(playerSpaceRates([1, 0, 0], up)[0]).toBeCloseTo(R, 3) // turning left
    expect(Math.abs(playerSpaceRates([1, 0, 0], up)[1])).toBeLessThan(0.01)
    expect(playerSpaceRates([0, -1, 0], up)[1]).toBeCloseTo(R, 3) // aiming up = upper long edge toward the user
    expect(Math.abs(playerSpaceRates([0, 0, 1], up)[0])).toBeLessThan(0.01) // steering-wheel roll is ignored
  })

  it('held sideways the other way', () => {
    const up: [number, number, number] = [-1, 0, 0]
    expect(playerSpaceRates([-1, 0, 0], up)[0]).toBeCloseTo(R, 3)
    expect(playerSpaceRates([0, 1, 0], up)[1]).toBeCloseTo(R, 3)
  })

  it('landscape tilted back 45 degrees still turns fully', () => {
    const t = Math.SQRT1_2
    const up: [number, number, number] = [t, 0, t]
    expect(playerSpaceRates([t, 0, t], up)[0]).toBeCloseTo(R, 3)
  })
})

describe('racing-style tilt stick', () => {
  const rotX = (deg: number): [number, number, number] => [0, Math.cos((deg * Math.PI) / 180), -Math.sin((deg * Math.PI) / 180)]
  it('portrait upright: steering-wheel tilt right is +x, top toward the user is +y, level is zero', () => {
    const t = new TiltStick(4, 30, 1)
    t.capture([0, 1, 0])
    expect(t.stick([0, 1, 0])).toEqual([0, 0])
    const s = (20 * Math.PI) / 180
    expect(t.angles([-Math.sin(s), Math.cos(s), 0])[0]).toBeCloseTo(20, 3) // wheel clockwise: world up drifts toward the phone's left
    expect(t.angles(rotX(20))[1]).toBeCloseTo(20, 3)
    expect(t.stick([-Math.sin(s), Math.cos(s), 0])[0]).toBeGreaterThan(0.5)
    expect(t.stick([-1, 0, 0])[0]).toBe(1) // saturates
  })

  it('landscape grip with rotation lock: steering still maps to x', () => {
    const t = new TiltStick(4, 30, 1)
    t.capture([1, 0, 0]) // phone sideways, top edge pointing left
    const s = (15 * Math.PI) / 180
    // wheel clockwise by 15 degrees: world up rotates toward the phone's top edge (+y) in phone coordinates
    expect(t.angles([Math.cos(s), Math.sin(s), 0])[0]).toBeCloseTo(15, 3)
    expect(Math.abs(t.angles([Math.cos(s), Math.sin(s), 0])[1])).toBeLessThan(0.01)
  })

  it('lying flat: right edge down steers right, top edge up pitches toward the user', () => {
    const t = new TiltStick(4, 30, 1)
    t.capture([0, 0, 1])
    const s = (10 * Math.PI) / 180
    expect(t.angles([-Math.sin(s), 0, Math.cos(s)])[0]).toBeCloseTo(10, 3)
    expect(t.angles([0, Math.sin(s), Math.cos(s)])[1]).toBeCloseTo(10, 3)
  })

  it('deadzone holds still near level', () => {
    const t = new TiltStick(4, 30, 1.6)
    t.capture([0, 1, 0])
    const s = (3 * Math.PI) / 180
    expect(t.stick([-Math.sin(s), Math.cos(s), 0])).toEqual([0, 0])
  })
})
