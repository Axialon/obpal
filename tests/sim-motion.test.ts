import { describe, expect, it } from 'vitest'
import { InputSmoother, servo, Spring } from '../src/sim/kit/motion'
import { DroneLogic } from '../src/sim/devices/drone'
import { RoverLogic } from '../src/sim/devices/rover'
import { restInput } from '../src/sim/devices/types'

describe('shared sim motion', () => {
  it('has the same response and integrated rotor travel at 30, 60 and 120 fps', () => {
    const run = (fps: number) => {
      const s = new Spring(0, 0.18); let travel = 0
      for (const target of [1, -0.4, 0]) for (let i = 0; i < fps; i++) { s.step(target, 1 / fps); travel += s.travel }
      return [s.value, s.velocity, travel]
    }
    const reference = run(120)
    for (const fps of [30, 60]) run(fps).forEach((v, i) => expect(v).toBeCloseTo(reference[i], 10))
  })
  it('starts and settles without overshoot and remains finite after a pause', () => {
    const s = new Spring()
    let previous = 0
    for (let i = 0; i < 120; i++) { const v = s.step(1, 1 / 60); expect(v).toBeGreaterThanOrEqual(previous); expect(v).toBeLessThanOrEqual(1); previous = v }
    expect(s.step(1, 20)).toBeCloseTo(1, 10)
    expect(s.step(NaN, 1 / 60)).toBe(1)
    expect(s.step(0, -1)).toBe(1)
  })
  it('attenuates packet jitter and clears old intent when input is released', () => {
    const f = new InputSmoother(); const values: number[] = []
    for (let i = 0; i < 120; i++) values.push(f.sample('tilt', i % 2 ? .6 : .4, 1 / 60))
    expect(Math.max(...values.slice(60)) - Math.min(...values.slice(60))).toBeLessThan(.02)
    f.reset(); expect(f.sample('tilt', 0, 1 / 60)).toBe(0)
  })
  it('preserves servo speed, acceleration and limits through starts, reversals and stops', () => {
    const limits = { min: -100, max: 100, vmax: 90, amax: 300 }
    const ends = [30, 60, 120].map(fps => {
      let p = 0, v = 0
      for (const target of [80, -80, 0]) for (let i = 0; i < fps * 3; i++) {
        const next = servo(p, v, target, 1 / fps, limits)
        expect(Math.abs(next.velocity)).toBeLessThanOrEqual(limits.vmax)
        expect(Math.abs(next.velocity - v)).toBeLessThanOrEqual(limits.amax / fps + 1e-8)
        expect(next.position).toBeGreaterThanOrEqual(limits.min); expect(next.position).toBeLessThanOrEqual(limits.max)
        p = next.position; v = next.velocity
      }
      return p
    })
    ends.forEach(p => expect(p).toBeCloseTo(0, 4))
    expect(ends[0]).toBeCloseTo(ends[2], 10)
  })

  it.each([30, 60, 120])('settles the live drone and rover after releasing input at %i fps', fps => {
    const drone = new DroneLogic(1), rover = new RoverLogic(1), dt = 1 / fps
    const input = { ...restInput(), pad: { flags: 0, seq: 0, t: 0, buttons: 0, axes: [0, 0, 0, 0] as [number, number, number, number], triggers: [0, 0] as [number, number] } }
    drone.step([{ ...input, presses: ['fly'] }], dt)
    for (let i = 0; i < fps * 2; i++) {
      rover.step([{ ...input, pad: { ...input.pad, axes: [.25, -.2, 0, 0] } }], dt)
      drone.step([input], dt)
    }
    drone.step([{ ...input, presses: ['fly'] }], dt)
    for (let i = 0; i < fps * 8; i++) { rover.step([null], dt); drone.step([null], dt) }
    const r = rover.rovers[0], d = drone.drones[0]
    expect(r.v).toBeCloseTo(0, 8); expect(r.steer).toBeCloseTo(0, 8)
    expect(d.phase).toBe('landed'); expect(d.rotor).toBeLessThan(.0001)
    expect(Math.abs(d.pitch) + Math.abs(d.roll)).toBeLessThan(.0001)
  })
})
