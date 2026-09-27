import { expect, it } from 'vitest'
import { qAxisAngle } from '@obpal/core'
import { SKY_OBJECTS, TelescopeLogic } from '../src/sim/devices/telescope'
import { restInput } from '../src/sim/devices/types'

it('points absolutely, holds still, rebases Home and follows gyro 1:1', () => {
  const l = new TelescopeLogic(), i = restInput(); i.point = { x: 0, y: 0, yaw: 20, pitch: 10, off: false }
  l.step([i], 0.05); expect(l.units[0].pan).toBeCloseTo(-Math.PI / 9)
  l.home(0); l.step([i], 0.05); expect(l.units[0].pan).toBe(0)
  i.point = null; i.hold = qAxisAngle(0, 1, 0, 0.5); const m = new TelescopeLogic(); m.step([i], 0.05)
  expect(m.units[0].pan).toBeCloseTo(0.5)
})
it('bounds drag, mount elevation and zoom and stops quiet input', () => {
  const l = new TelescopeLogic(), i = restInput(); i.drag = [10000, -10000]; i.pinch = 100
  l.step([i], 0.05); expect(l.units[0]).toMatchObject({ pan: -1.45, elevation: 1.2, zoom: 8 })
  i.quiet = true; i.drag = [-10000, 10000]; i.pinch = -100; l.step([i], 0.05)
  expect(l.units[0]).toMatchObject({ pan: -1.45, elevation: 1.2, zoom: 8 })
})
it('only records centred named targets, once per player, and preserves the log on Home', () => {
  const l = new TelescopeLogic(), i = restInput(); i.presses = ['find']
  l.step([i], 0.05); l.step([i], 0.05); expect(l.units[0].found).toEqual([0])
  Object.assign(l.units[0], { pan: SKY_OBJECTS[1].pan, elevation: SKY_OBJECTS[1].elevation })
  l.step([i], 0.05); expect(l.units[0].found).toEqual([0, 1]); expect(l.units[1].found).toEqual([])
  l.home(0); expect(l.units[0].found).toEqual([0, 1])
  l.units[0].pan = 1; l.step([i], 0.05); expect(l.units[0].found).toHaveLength(2)
})
