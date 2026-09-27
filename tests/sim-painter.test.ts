import { expect, it } from 'vitest'
import { PainterLogic } from '../src/sim/devices/painter'
import { restInput } from '../src/sim/devices/types'
it('paints phone motion only while held and separates strokes after tracking is lost', () => {
  const l = new PainterLogic(),
    i = restInput('face.hand')
  i.pose = { p: [0, 0, 0], q: [0, 0, 0, 1], tracked: true, touching: true, gen: 1 }
  l.step([i], 0.05)
  i.pose.p = [0.1, 0, 0]
  l.step([i], 0.05)
  expect(l.strokes.length).toBe(1)
  i.pose.tracked = false
  l.step([i], 0.05)
  i.pose.tracked = true
  i.pose.p = [1, 0, 0]
  l.step([i], 0.05)
  expect(l.strokes.length).toBe(1)
})
it('bounds pointing, keeps a finite exposure and clears it from a button', () => {
  const l = new PainterLogic(),
    i = restInput('face.mouse')
  i.held = new Set(['mouse-left'])
  for (let n = 0; n < 1000; n++) {
    i.point = { x: 0, y: 0, yaw: n % 2 ? 90 : -90, pitch: 90, off: false }
    l.step([i], 0.05)
  }
  expect(l.strokes.length).toBe(512)
  expect(l.units[0].y).toBeCloseTo(3.5)
  i.presses = ['clear', 'colour']
  l.step([i], 0.05)
  expect(l.strokes.length).toBe(0)
  expect(l.units[0].colour).toBe(1)
  l.home()
  expect(l.units[0].x).toBe(0)
})
it('supports a thumb painting on the trackpad with depth from two fingers', () => {
  const l = new PainterLogic(),
    i = restInput('face.trackpad')
  i.touching = true
  l.step([i], 0.05)
  i.drag = [20, -10]
  i.pan = [0, 10]
  l.step([i], 0.05)
  expect(l.units[0].x).toBeGreaterThan(0)
  expect(l.units[0].z).toBeGreaterThan(0)
  expect(l.strokes.length).toBe(1)
})
