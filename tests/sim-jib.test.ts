import { expect, it } from 'vitest'
import { qAxisAngle } from '@obpal/core'
import { JibLogic, jibTip } from '../src/sim/devices/jib'
import { restInput } from '../src/sim/devices/types'

it('maps two sticks to four axes and keeps the head above the stage', () => {
  const l = new JibLogic(), i = restInput(); i.pad = { axes: [1, -1, -1, 1], triggers: [0, 0], buttons: 0, seq: 0, t: 0, flags: 0 }
  for (let n = 0; n < 200; n++) l.step([i], 0.05)
  expect(l.units[0]).toMatchObject({ swing: -1.1, boom: 0.9, pan: 1.5, tilt: -1.1 })
  expect(jibTip(1.1, -0.15).y).toBeGreaterThan(1); expect(l.units[1].swing).toBe(0)
})
it('drags the arm, aims the head 1:1, and rebases its orientation on Home', () => {
  const l = new JibLogic(), i = restInput(); i.drag = [30, -20]; i.hold = qAxisAngle(0, 1, 0, 0.4)
  l.step([i], 0.05); expect(l.units[0].swing).toBeCloseTo(-0.12); expect(l.units[0].pan).toBeCloseTo(0.4)
  i.drag = [0, 0]; l.home(0); l.step([i], 0.05); expect(l.units[0].pan).toBe(0)
  i.quiet = true; i.drag = [100, 100]; l.step([i], 0.05); expect(l.units[0].swing).toBe(0)
})
it('records and ends a take, retaining completed takes when Home stops the head', () => {
  const l = new JibLogic(), i = restInput(); i.presses = ['record']; l.step([i], 0.05)
  expect(l.units[0].recording).toBe(true); i.presses = []; l.step([i], 0.05); expect(l.units[0].time).toBeCloseTo(0.1)
  i.presses = ['record']; l.step([i], 0.05); expect(l.units[0].takes).toBe(1)
  l.home(0); expect(l.units[0]).toMatchObject({ takes: 1, recording: false, time: 0 })
})
