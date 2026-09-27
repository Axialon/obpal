import { expect, it } from 'vitest'
import { qAxisAngle, qMul } from '@obpal/core'
import { GimbalLogic, unitQuaternion } from '../src/sim/devices/gimbal'
import { restInput } from '../src/sim/devices/types'
it('follows yaw, pitch and roll one for one and holds when tracking stops', () => {
  const l = new GimbalLogic(),
    i = restInput('face.trackpad'),
    q = qMul(qAxisAngle(0, 1, 0, 0.8), qMul(qAxisAngle(1, 0, 0, 0.3), qAxisAngle(0, 0, 1, -0.4)))
  i.hold = q
  l.step([i])
  q.forEach((v, n) => expect(l.units[0].q[n]).toBeCloseTo(v))
  l.step([null])
  l.step([restInput('face.trackpad')])
  q.forEach((v, n) => expect(l.units[0].q[n]).toBeCloseTo(v))
  expect(l.units[0].pan).toBeCloseTo(0.8)
  l.home()
  l.step([i])
  expect(l.units[0].pan).toBeCloseTo(0)
})
it('normalizes orientation, rejects a degenerate quaternion and records takes', () => {
  expect(unitQuaternion([0, 0, 0, 0])).toEqual([0, 0, 0, 1])
  const l = new GimbalLogic(),
    i = restInput('face.hand')
  i.pose = { p: [0, 0, 0], q: [0, 2, 0, 2], tracked: true, touching: true, gen: 1 }
  i.presses = ['record']
  l.step([i])
  expect(Math.hypot(...l.units[0].q)).toBeCloseTo(1)
  expect(l.units[0].recording).toBe(true)
  expect(l.units[0].takes).toBe(1)
})
it('supports dragging and twisting without sensors and limits pitch', () => {
  const l = new GimbalLogic(),
    i = restInput('face.trackpad')
  i.drag = [10, -1000]
  i.twist = 90
  l.step([i])
  expect(l.units[0].pitch).toBe(1.5)
  expect(l.units[0].roll).toBeCloseTo(Math.PI / 2)
})
