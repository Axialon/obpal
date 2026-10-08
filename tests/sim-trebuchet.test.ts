import { expect, it } from 'vitest'
import { TrebuchetLogic, shotSpeed } from '../src/sim/devices/trebuchet'
import { restInput } from '../src/sim/devices/types'
import { loadPosition, loadTangent, releaseArm, READY_ARM } from '../src/sim/devices/trebuchet.geometry'

it('adjusts bounded counterweight and release angle, ignoring quiet movement', () => {
  const l = new TrebuchetLogic(), i = restInput(); i.drag = [10000, -10000]; l.step([i], 0.05)
  expect(l.units[0]).toMatchObject({ weight: 50, angle: 75 }); i.quiet = true; i.drag = [-10000, 10000]; l.step([i], 0.05)
  expect(l.units[0].weight).toBe(50); expect(l.units[1].weight).toBe(25)
})
it('releases one shot, follows gravity after disconnect and cannot launch again in flight', () => {
  const l = new TrebuchetLogic(), i = restInput(); i.presses = ['launch']; l.step([i], 0.05)
  l.step([i], 0.05); expect(l.units[0].shots).toBe(1)
  for (let n = 0; n < 14; n++) l.step([], 0.05)
  expect(l.units[0].phase).toBe('flight')
  expect(Math.hypot(l.units[0].vy, l.units[0].vz)).toBeLessThan(shotSpeed(25))
  for (let n = 0; n < 200; n++) l.step([], 0.05)
  expect(l.units[0].phase).toBe('ready'); expect(l.units[0].last).toBeGreaterThan(15); expect(l.units[0].arc.length).toBeLessThanOrEqual(240)
})
it('scores the landing once, retains points on Home, and clears the trajectory', () => {
  const l = new TrebuchetLogic(); Object.assign(l.units[0], { phase: 'flight', y: 0.13, z: -14, vy: -2, vz: 0 })
  l.step([], 0.05); expect(l.units[0].score).toBe(20); l.step([], 0.05); expect(l.units[0].score).toBe(20)
  l.home(0); expect(l.units[0].score).toBe(20); expect(l.units[0].arc).toEqual([])
})
it('releases both lanes from the visible linkage with a tangent matching every bounded angle', () => {
  for (const angle of [20, 45, 75]) for (const weight of [5, 25, 50]) {
    const l = new TrebuchetLogic(), i = restInput(); i.presses = ['launch']
    l.units.forEach(u => { u.angle = angle; u.weight = weight })
    l.step([i, i], .01)
    let previous = READY_ARM
    while (l.units[0].phase === 'winding') {
      expect(l.units[0].arm).toBeLessThan(previous); previous = l.units[0].arm; l.step([], .01)
    }
    for (const u of l.units) {
      const a = angle * Math.PI / 180, radius = Math.hypot(.4, 2.12)
      // Independent side-plane geometry: the radius is normal to the chosen launch vector.
      expect(u.y).toBeCloseTo(2 + radius * Math.cos(a), 10)
      expect(u.z).toBeCloseTo(radius * Math.sin(a), 10)
      expect(u.arm).toBeCloseTo(releaseArm(angle), 10)
      expect(loadPosition(u.arm)).toEqual([u.x, u.y, u.z])
      const tangent = loadTangent(u.arm), magnitude = Math.hypot(...tangent)
      expect(tangent[1] / magnitude).toBeCloseTo(Math.sin(a), 10)
      expect(tangent[2] / magnitude).toBeCloseTo(-Math.cos(a), 10)
      expect(u.vy).toBeCloseTo(shotSpeed(weight) * tangent[1] / magnitude, 10)
      expect(u.vz).toBeCloseTo(shotSpeed(weight) * tangent[2] / magnitude, 10)
    }
    const initial = l.units.map(u => ({ ...u })), dt = .05; l.step([], dt)
    l.units.forEach((u, n) => { expect(u.y).toBeCloseTo(initial[n].y + initial[n].vy * dt - .5 * 9.81 * dt * dt, 10); expect(u.z).toBeCloseTo(initial[n].z + initial[n].vz * dt, 10) })
    expect(l.units[1].shots).toBe(1)
    l.home(0); expect(l.units[0].arm).toBe(READY_ARM); expect([l.units[0].x, l.units[0].y, l.units[0].z]).toEqual(loadPosition(READY_ARM))
  }
})
