import { expect, it } from 'vitest'
import { TrebuchetLogic, shotSpeed } from '../src/sim/devices/trebuchet'
import { restInput } from '../src/sim/devices/types'

it('adjusts bounded counterweight and release angle, ignoring quiet movement', () => {
  const l = new TrebuchetLogic(), i = restInput(); i.drag = [10000, -10000]; l.step([i], 0.05)
  expect(l.units[0]).toMatchObject({ weight: 50, angle: 75 }); i.quiet = true; i.drag = [-10000, 10000]; l.step([i], 0.05)
  expect(l.units[0].weight).toBe(50); expect(l.units[1].weight).toBe(25)
})
it('releases one shot, follows gravity after disconnect and cannot launch again in flight', () => {
  const l = new TrebuchetLogic(), i = restInput(); i.presses = ['launch']; l.step([i], 0.05)
  l.step([i], 0.05); expect(l.units[0].shots).toBe(1)
  for (let n = 0; n < 14; n++) l.step([], 0.05)
  expect(l.units[0].phase).toBe('flight')
  expect(Math.hypot(l.units[0].vy, l.units[0].vz)).toBeLessThan(shotSpeed(25))
  for (let n = 0; n < 200; n++) l.step([], 0.05)
  expect(l.units[0].phase).toBe('ready'); expect(l.units[0].last).toBeGreaterThan(15); expect(l.units[0].arc.length).toBeLessThanOrEqual(240)
})
it('scores the landing once, retains points on Home, and clears the trajectory', () => {
  const l = new TrebuchetLogic(); Object.assign(l.units[0], { phase: 'flight', y: 0.13, z: -14, vy: -2, vz: 0 })
  l.step([], 0.05); expect(l.units[0].score).toBe(20); l.step([], 0.05); expect(l.units[0].score).toBe(20)
  l.home(0); expect(l.units[0].score).toBe(20); expect(l.units[0].arc).toEqual([])
})
