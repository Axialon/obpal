import { expect, it } from 'vitest'
import { VacuumLogic, FURNITURE, DOCK, dockRoute } from '../src/sim/devices/vacuum'
import { blocked } from '../src/sim/devices/common'
import { restInput } from '../src/sim/devices/types'
it('drives toward a pointed spot, cleans dust and stops on release', () => {
  const l = new VacuumLogic(),
    i = restInput('face.wii')
  i.point = { x: 0, y: 0, yaw: 0, pitch: 0, off: false }
  i.spot = [-2, 0]
  i.held = new Set(['wii-b'])
  const u = l.units[0]
  l.dust.push({ x: -2, z: 1.5, cleaned: false })
  for (let n = 0; n < 60; n++) l.step([i], 1 / 60)
  expect(u.z).toBeLessThan(1)
  expect(u.collected).toBeGreaterThan(0)
  l.step([null], 1 / 60)
  expect(u.v).toBe(0)
})
it('routes around furniture to charge and never crosses it', () => {
  const l = new VacuumLogic(),
    u = l.units[0]
  u.x = 4
  u.z = -3
  expect(dockRoute(u.x, u.z).length).toBeGreaterThan(3)
  l.home()
  for (let n = 0; n < 2400 && !u.docked; n++) {
    l.step([null], 1 / 60)
    expect(blocked(u.x, u.z, 0.34, FURNITURE)).toBe(false)
  }
  expect(u.docked).toBe(true)
  expect([u.x, u.z]).toEqual([...DOCK])
})
it('maps a dragged thumb and cleaning button without leaving the room', () => {
  const l = new VacuumLogic(),
    i = restInput('face.trackpad')
  i.touching = true
  i.drag = [20, -90]
  i.presses = ['clean']
  l.step([i], 0.05)
  expect(l.units[0].clean).toBe(false)
  i.drag = [0, 0]
  i.presses = []
  for (let n = 0; n < 2000; n++) l.step([i], 0.05)
  expect(Math.abs(l.units[0].x)).toBeLessThanOrEqual(4.5)
  expect(Math.abs(l.units[0].z)).toBeLessThanOrEqual(3.5)
})
