import { expect, it } from 'vitest'
import { BoatLogic, BUOYS } from '../src/sim/devices/boat'
import { restInput } from '../src/sim/devices/types'
it('steers a boat with a dragged thumb, coasts safely, and homes at the dock', () => {
  const l = new BoatLogic(),
    i = restInput('face.trackpad')
  i.touching = true
  i.drag = [30, -70]
  for (let n = 0; n < 120; n++) {
    l.step([i], 1 / 60)
    i.drag = [0, 0]
  }
  expect(l.units[0].h).toBeLessThan(-0.1)
  expect(l.units[0].z).toBeLessThan(1)
  for (let n = 0; n < 1200; n++) l.step([null], 1 / 60)
  expect(Math.abs(l.units[0].v)).toBeLessThan(0.01)
  expect(Math.abs(l.units[0].x)).toBeLessThanOrEqual(10)
  l.home(0)
  expect([l.units[0].x, l.units[0].z, l.units[0].v]).toEqual([-2, 1, 0])
})
it('counts buoys in order and handles the headset horn action', () => {
  const l = new BoatLogic()
  l.units[0].x = BUOYS[0][0]
  l.units[0].z = BUOYS[0][1]
  const i = restInput()
  i.presses = ['horn']
  l.step([i], 1 / 60)
  expect(l.units[0].next).toBe(1)
  expect(l.units[0].horn).toBeGreaterThan(0)
  expect(l.drain().some((e) => e.kind === 'score')).toBe(true)
})
