import { expect, it } from 'vitest'
import { EARTH_TO_VIEW, qAxisAngle, qMul, qRotate, quatFromDeviceOrientation, type Quat } from '@obpal/core'
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

it('decodes a 3D hand relative to its grip and heading, and holds through re-grabs', () => {
  for (const beta of [0, 60, 90]) for (const screen of [0, 90, 270]) for (const view of [null, 0, Math.PI]) {
    const l = new GimbalLogic(), i = restInput('face.hand')
    if (view !== null) i.controlFrame = { yaw: view, heading: 0, immersive: false }
    const zero = qMul(EARTH_TO_VIEW, quatFromDeviceOrientation(137, beta, 0, screen))
    i.pose = { p: [0, 0, 0], q: zero, tracked: true, touching: true, gen: 1 }
    l.step([i])
    expect(l.units[0].q[3]).toBeCloseTo(1)
    // A 30-degree turn about world up is a 30-degree turn about view up, regardless of starting heading.
    i.pose.q = qMul(qAxisAngle(0, 1, 0, Math.PI / 6), zero)
    l.step([i])
    expect(l.units[0].pan).toBeCloseTo((view === Math.PI ? -1 : 1) * Math.PI / 6)
    const before = [...l.units[0].q] as Quat
    i.pose.gen++; l.step([i])
    qRotate(l.units[0].q, [1, 0, 0]).forEach((v, n) => expect(v).toBeCloseTo(qRotate(before, [1, 0, 0])[n]))
  }
})

it('Home removes the previous turn in the fixed view, not in the rotated device axes', () => {
  const l = new GimbalLogic(), i = restInput('face.trackpad')
  const zero = qMul(qAxisAngle(0, 1, 0, 0.7), qAxisAngle(0, 0, 1, 0.4))
  i.hold = zero; l.step([i]); l.home()
  const pitch = qAxisAngle(1, 0, 0, 0.3)
  i.hold = qMul(pitch, zero); l.step([i])
  l.units[0].q.forEach((v, n) => expect(v).toBeCloseTo(pitch[n]))
})

it('keeps the exact quaternion through upright while retaining the overview pan convention', () => {
  const yaw = 0.8, roll = -0.4
  for (const pitch of [0.3, Math.PI / 2 - 1e-8, Math.PI / 2, Math.PI / 2 + 1e-8]) {
    const l = new GimbalLogic(), i = restInput('face.trackpad')
    const q = qMul(qMul(qAxisAngle(0, 1, 0, yaw), qAxisAngle(1, 0, 0, pitch)), qAxisAngle(0, 0, 1, roll))
    i.hold = q; i.controlFrame = { yaw: 0, heading: 0, immersive: false }
    l.step([i])
    for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
      qRotate(l.units[0].q, [...axis]).forEach((v, n) => expect(v).toBeCloseTo(qRotate(q, [...axis])[n], 10))
    }
    if (pitch === 0.3) {
      i.controlFrame.yaw = Math.PI; l.step([i])
      const reversedPan = qMul(qMul(qAxisAngle(0, 1, 0, -yaw), qAxisAngle(1, 0, 0, pitch)), qAxisAngle(0, 0, 1, roll))
      l.units[0].q.forEach((v, n) => expect(v).toBeCloseTo(reversedPan[n], 10))
    }
  }
})
