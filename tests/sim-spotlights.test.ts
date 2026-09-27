import { expect, it } from 'vitest'
import { SpotlightsLogic } from '../src/sim/devices/spotlights'
import { restInput } from '../src/sim/devices/types'
it('points a head, respects its stops, and freezes its motors when input goes quiet', () => {
  const l = new SpotlightsLogic(),
    i = restInput('face.wii')
  i.point = { x: 0, y: 0, yaw: 1000, pitch: -1000, off: false }
  for (let n = 0; n < 120; n++) l.step([i], 1 / 60)
  expect(l.units[0].x).toBe(5)
  expect(l.units[0].z).toBe(4)
  expect(l.units[0].pan).toBeLessThan(Math.PI / 2)
  const pan = l.units[0].pan
  l.step([null], 1)
  const quiet = restInput('face.wii')
  quiet.quiet = true
  l.step([quiet], 0.05)
  expect(l.units[0].pan).toBe(pan)
  l.home(0)
  expect(l.units[0].pan).toBe(0)
})
it('drags an aim and cycles colour and gobo independently', () => {
  const l = new SpotlightsLogic(),
    i = restInput('face.trackpad')
  i.drag = [80, 30]
  i.presses = ['colour', 'gobo']
  l.step([i], 1 / 60)
  expect(l.units[0].x).toBeCloseTo(-1.8)
  expect(l.units[0].colour).toBe(1)
  expect(l.units[0].gobo).toBe(1)
})
