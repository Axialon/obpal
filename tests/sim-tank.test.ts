import { expect, it } from 'vitest'
import { TankLogic } from '../src/sim/devices/tank'
import { restInput } from '../src/sim/devices/types'
it('gyro Aim on the right stick turns only the turret and clamps its elevation', () => {
  const l = new TankLogic(),
    i = restInput()
  i.pad = { axes: [0, 0, 1, -1], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 }
  for (let n = 0; n < 120; n++) l.step([i], 1 / 60)
  expect(l.units[0].turret).not.toBe(0)
  expect(l.units[0].h).toBe(0)
  expect(l.units[0].elevation).toBe(0.6)
  const a = l.units[0].turret
  l.step([null], 1 / 60)
  expect(l.units[0].turret).toBe(a)
})
it('fires finite soft balls at targets and restores the course', () => {
  const l = new TankLogic(),
    i = restInput()
  l.units[0].x = 0
  i.presses = ['fire']
  l.step([i], 1 / 60)
  for (let n = 0; n < 100; n++) l.step([null], 1 / 60)
  expect(l.units[0].score).toBe(1)
  expect(l.units[0].shots).toBe(1)
  l.reset()
  expect(l.targets.every((t) => t.up)).toBe(true)
  l.home(0)
  expect(l.units[0].x).toBe(-2)
})
it('uses a two-finger pan for aiming and keeps driving within the yard', () => {
  const l = new TankLogic(),
    i = restInput('face.trackpad')
  i.pan = [20, 0]
  i.touching = true
  i.drag = [0, -90]
  l.step([i], 0.05)
  expect(l.units[0].turret).toBeCloseTo(-0.24)
  i.pan = [0, 0]
  i.drag = [0, 0]
  for (let n = 0; n < 1000; n++) l.step([i], 0.05)
  expect(l.units[0].z).toBeGreaterThanOrEqual(-7)
})
