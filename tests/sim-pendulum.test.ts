import { expect, it } from 'vitest'
import { Mode } from '@obpal/core'
import { PendulumLogic } from '../src/sim/devices/pendulum'
import { restInput } from '../src/sim/devices/types'

it('bounds length and damping from touch and isolates each experiment', () => {
  const l = new PendulumLogic(), i = restInput(); i.drag = [10000, -10000]; l.step([i], 0.05)
  expect(l.units[0]).toMatchObject({ length: 2.2, damping: 1.2 }); expect(l.units[1].length).toBe(1.45)
  i.drag = [-10000, 10000]; l.step([i], 0.05); expect(l.units[0]).toMatchObject({ length: 0.55, damping: 0 })
})
it('pushes from a quick phone tilt, debounces and ignores stale sensor changes', () => {
  const l = new PendulumLogic(), i = restInput('face.trackpad', Mode.tilt)
  l.step([i], 0.05); i.tilt = [0.6, 0]; l.step([i], 0.05)
  expect(l.units[0].actions).toBe(1); expect(l.units[0].omega).toBeGreaterThan(1)
  i.tilt = [-0.6, 0]; l.step([i], 0.05); expect(l.units[0].actions).toBe(1)
  i.quiet = true; for (let n = 0; n < 20; n++) l.step([i], 0.05)
  expect(l.units[0].actions).toBe(1)
})
it('follows the expected small-angle period and damping dissipates energy', () => {
  const l = new PendulumLogic(); const u = l.units[0]; u.angle = 0.1; u.damping = 0
  const period = 2 * Math.PI * Math.sqrt(u.length / 9.81)
  for (let t = 0; t < period; t += 1 / 240) l.step([], 1 / 240)
  expect(u.angle).toBeCloseTo(0.1, 2)
  u.damping = 1; for (let n = 0; n < 200; n++) l.step([], 0.05)
  expect(Math.abs(u.angle) + Math.abs(u.omega)).toBeLessThan(0.01)
  expect(u.trace.length).toBeLessThanOrEqual(300); l.home(0); expect(u.trace).toEqual([])
})
