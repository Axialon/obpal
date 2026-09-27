import { expect, it } from 'vitest'
import { SliderLogic, easeShot } from '../src/sim/devices/slider'
import { restInput } from '../src/sim/devices/types'

it('maps travel and head drags independently with bounded motors and quiet input', () => {
  const l = new SliderLogic(), i = restInput(); i.drag = [1000, 0]; i.pan = [1000, -1000]; l.step([i], 0.05)
  expect(l.units[0]).toMatchObject({ x: 1.7, pan: -1.2, tilt: 0.8 }); expect(l.units[1].x).toBe(0)
  i.quiet = true; i.drag = [-1000, 0]; l.step([i], 0.05); expect(l.units[0].x).toBe(1.7)
})
it('records six keys at most, requires two, and completes one smooth programmed move', () => {
  const l = new SliderLogic(), i = restInput(); i.presses = ['play']; l.step([i], 0.05); expect(l.units[0].playing).toBe(false)
  i.presses = ['key']; l.units[0].x = -1; l.step([i], 0.05); l.units[0].x = 1; l.units[0].pan = 0.4; l.step([i], 0.05)
  i.presses = ['play']; l.step([i], 0.05); i.presses = []
  for (let n = 0; n < 79; n++) l.step([], 0.05)
  expect(l.units[0].x).toBeCloseTo(0); expect(l.units[0].pan).toBeCloseTo(0.2)
  for (let n = 0; n < 90; n++) l.step([], 0.05)
  expect(l.units[0]).toMatchObject({ x: 1, pan: 0.4, takes: 1, playing: false })
  i.presses = ['key']; for (let n = 0; n < 12; n++) l.step([i], 0.05)
  expect(l.units[0].keys).toHaveLength(6)
  expect(easeShot(0.001)).toBeLessThan(0.000001); expect(easeShot(0.999)).toBeGreaterThan(0.999999)
})
it('interrupts playback with manual movement or Home and preserves authored keys', () => {
  const l = new SliderLogic(), i = restInput(); l.units[0].keys = [{ x: -1, pan: 0, tilt: 0 }, { x: 1, pan: 0.2, tilt: 0.1 }]; l.units[0].playing = true
  i.drag = [10, 0]; l.step([i], 0.05); expect(l.units[0].playing).toBe(false)
  l.home(0); expect(l.units[0].keys).toHaveLength(2); expect(l.units[0].x).toBe(0)
  i.drag = [0, 0]; i.presses = ['clear']; l.step([i], 0.05); expect(l.units[0].keys).toEqual([])
})
