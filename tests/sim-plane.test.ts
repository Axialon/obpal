import { expect, it } from 'vitest'
import { PlaneLogic, FLIGHT_RINGS } from '../src/sim/devices/plane'
import { restInput } from '../src/sim/devices/types'
it('takes off with power, banks with the flight stick, and glides after the watchdog cuts power', () => {
  const l = new PlaneLogic(),
    i = restInput()
  i.pad = { axes: [0, 0, 0, 0], triggers: [0, 1], buttons: 0, flags: 0, seq: 0, t: 0 }
  for (let n = 0; n < 300; n++) l.step([i], 1 / 60)
  expect(l.units[0].y).toBeGreaterThan(0.5)
  i.pad.axes[2] = 1
  for (let n = 0; n < 60; n++) l.step([i], 1 / 60)
  expect(l.units[0].h).toBeLessThan(0)
  for (let n = 0; n < 1800; n++) l.step([null], 1 / 60)
  expect(l.units[0].throttle).toBe(0)
  expect(l.units[0].y).toBe(0.23)
  expect(Math.abs(l.units[0].x)).toBeLessThanOrEqual(30)
})
it('counts rings in order, caps height and speed, and Home parks on the runway', () => {
  const l = new PlaneLogic(),
    u = l.units[0]
  ;[u.x, u.y, u.z] = [...FLIGHT_RINGS[0]]
  l.step([null], 0.05)
  expect(u.rings).toBe(1)
  u.y = 100
  u.v = 100
  l.step([null], 0.05)
  expect(u.y).toBeLessThanOrEqual(12)
  expect(u.v).toBeLessThanOrEqual(7.5)
  l.home()
  expect([u.y, u.z, u.v]).toEqual([0.23, 8, 0])
})
it('uses a trackpad engine button and held drag as a yoke', () => {
  const l = new PlaneLogic(),
    i = restInput('face.trackpad')
  i.touching = true
  i.drag = [40, -40]
  i.presses = ['engine']
  l.step([i], 0.05)
  expect(l.units[0].powered).toBe(true)
  expect(l.units[0].bank).toBeLessThan(0)
  expect(l.units[0].pitch).toBeGreaterThan(0)
})

it('cuts a latched tilt engine when the holder becomes quiet', () => {
  const l = new PlaneLogic(),
    i = restInput('face.trackpad', 3)
  i.presses = ['engine']
  l.step([i], 0.05)
  expect(l.units[0].throttle).toBeGreaterThan(0)
  i.presses = []
  i.quiet = true
  l.step([i], 0.05)
  expect(l.units[0].throttle).toBe(0)
})
