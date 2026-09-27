import { expect, it } from 'vitest'
import { SlotcarsLogic, laneLength, slotPose } from '../src/sim/devices/slotcars'
import { restInput } from '../src/sim/devices/types'
it('takes throttle alone, releases in a fast corner and comes back with the bound action', () => {
  const l = new SlotcarsLogic(),
    i = restInput('face.wheel')
  i.pad = { axes: [1, 1, 1, 1], triggers: [0, 1], buttons: 0, flags: 0, seq: 0, t: 0 }
  for (let n = 0; n < 300; n++) l.step([i], 1 / 60)
  expect(l.units[0].off).toBe(true)
  expect(l.drain().some((e) => e.kind === 'fall')).toBe(true)
  i.pad.triggers = [0, 0]
  i.presses = ['reslot']
  l.step([i], 1 / 60)
  expect(l.units[0].off).toBe(false)
  expect(l.units[0].s).toBe(3.8)
})
it('stops safely with no input and never accelerates from steering', () => {
  const l = new SlotcarsLogic(),
    i = restInput()
  i.pad = { axes: [1, 1, 1, 1], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 }
  l.step([i], 0.05)
  expect(l.units[0].v).toBe(0)
  l.units[0].v = 3
  for (let n = 0; n < 120; n++) l.step([null], 1 / 60)
  expect(l.units[0].v).toBe(0)
})
it('joins straights and bends continuously and counts laps at the line', () => {
  for (let n = 0; n < 4; n++) {
    const a = slotPose(8 - 0.001, n),
      b = slotPose(8 + 0.001, n)
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.003)
  }
  const l = new SlotcarsLogic()
  l.units[0].s = laneLength(0) - 0.01
  l.units[0].v = 2
  l.step([null], 0.05)
  expect(l.units[0].laps).toBe(1)
})

it('points along the lane tangent throughout both bends, including when a car flies off', () => {
  for (let lane = 0; lane < 4; lane++) for (let s = 0; s < laneLength(lane); s += 0.3) {
    const a = slotPose(s, lane), b = slotPose(s + 0.001, lane)
    expect((b.x - a.x) / 0.001).toBeCloseTo(-Math.sin(a.h), 2)
    expect((b.z - a.z) / 0.001).toBeCloseTo(-Math.cos(a.h), 2)
  }
})
