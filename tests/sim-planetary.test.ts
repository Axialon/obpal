import { expect, it } from 'vitest'
import { PlanetaryLogic, terrain } from '../src/sim/devices/planetary'
import { restInput } from '../src/sim/devices/types'

it('drives over terrain under low gravity and bounds the world', () => {
  const l = new PlanetaryLogic(), i = restInput(); i.touching = true; i.drag = [0, -90]
  for (let n = 0; n < 500; n++) l.step([i], 0.05)
  expect(l.units[0].z).toBe(-8); expect(l.units[0].y).toBeGreaterThanOrEqual(terrain(l.units[0].x, -8))
  expect(l.units[0].v).toBeLessThanOrEqual(1.6); expect(l.units[1].z).toBe(3)
  l.units[0].y = 5; l.units[0].vy = 0; l.step([], 0.05)
  expect(l.units[0].vy).toBeCloseTo(-1.62 * 0.05)
})
it('operates the arm and mast separately with mechanical limits and watchdog', () => {
  const l = new PlanetaryLogic(), i = restInput(); i.pan = [1000, -1000]
  l.step([i], 0.05); expect(l.units[0].swing).toBe(-1.4); expect(l.units[0].boom).toBe(0.9)
  i.presses = ['mast']; l.step([i], 0.05); expect(l.units[0].mastPan).toBe(-Math.PI)
  const before = l.units[0].mastTilt; i.presses = []; i.quiet = true; i.pan = [0, 1000]; l.step([i], 0.05)
  expect(l.units[0].mastTilt).toBe(before)
})
it('samples a reachable rock once and keeps collected samples through Home', () => {
  const l = new PlanetaryLogic(), i = restInput(); i.presses = ['sample']
  l.step([i], 0.05); expect(l.units[0].samples).toBe(1)
  l.step([i], 0.05); expect(l.units[0].samples).toBe(1)
  l.home(0); expect(l.units[0].samples).toBe(1); expect(l.rocks[0].sampled).toBe(true)
  l.reset(); expect(l.units[0].samples).toBe(0); expect(l.rocks[0].sampled).toBe(false)
})
