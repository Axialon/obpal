import { expect, it } from 'vitest'
import { ExcavatorLogic, bucketPose, bucketTip } from '../src/sim/devices/excavator'
import { restInput } from '../src/sim/devices/types'
it('maps the excavator pattern and holds every joint at its limits without input', () => {
  const l = new ExcavatorLogic(),
    i = restInput()
  i.pad = { axes: [1, 1, -1, 1], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 }
  const u = l.units[0]
  l.step([i], 0.05)
  expect(u.swing).toBeLessThan(0)
  expect(u.stick).toBeLessThan(-1.35)
  expect(u.boom).toBeGreaterThan(0.65)
  expect(u.curl).toBeGreaterThan(0.15)
  for (let n = 0; n < 1000; n++) l.step([i], 0.05)
  expect(u.boom).toBeLessThanOrEqual(1.35)
  expect(u.stick).toBeGreaterThanOrEqual(-2.4)
  expect(bucketTip(u)[1]).toBeGreaterThanOrEqual(0.08)
  const before = { ...u }
  l.step([null], 1)
  expect(u).toEqual(before)
})
it('conserves sand when scooping, dumping into the truck and resetting', () => {
  const l = new ExcavatorLogic(),
    u = l.units[0],
    i = restInput()
  Object.assign(u, bucketPose(0, 0.5, -2.5), { curl: 1 })
  l.step([i], 1 / 60)
  expect(u.load).toBe(1)
  expect(l.sand).toBe(19)
  Object.assign(u, bucketPose(2.6, 1.2, 0), { curl: 0 })
  l.step([i], 1 / 60)
  expect(u.delivered).toBe(1)
  expect(l.sand + u.load + u.delivered + l.spilled).toBe(20)
  l.reset()
  expect(l.sand).toBe(20)
})
it('moves the bucket with a tracked hand only while held', () => {
  const l = new ExcavatorLogic(),
    i = restInput('face.hand')
  i.pose = { p: [0, 0, 0], q: [0, 0, 0, 1], gen: 1, touching: true, tracked: true }
  l.step([i], 1 / 60)
  i.pose.p = [0.1, 0, 0]
  l.step([i], 1 / 60)
  expect(bucketTip(l.units[0])[0]).toBeCloseTo(0.4)
  const before = { ...l.units[0] }
  i.pose.touching = false
  i.pose.p = [1, 0, 0]
  l.step([i], 1 / 60)
  expect(l.units[0]).toEqual(before)
})
