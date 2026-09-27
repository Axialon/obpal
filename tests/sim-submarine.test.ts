import { Mode, PadButton } from '@obpal/core'
import { expect, it } from 'vitest'
import { SubmarineLogic, SUBMARINE_SPEC, SUBMARINE_WRECKS } from '../src/sim/devices/submarine'
import { restInput } from '../src/sim/devices/types'

function pad() {
  const i = restInput()
  i.pad = { axes: [0, 0, 0, 0], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 }
  return i
}
it('steers and thrusts with the left stick while triggers only change buoyancy', () => {
  const l = new SubmarineLogic(), i = pad(), u = l.units[0]
  i.pad!.triggers = [0, 1]
  for (let n = 0; n < 30; n++) l.step([i], 0.05)
  expect(u.y).toBeGreaterThan(4); expect(u.v).toBe(0); expect(u.ballast).toBeLessThan(0.12)
  i.pad!.axes = [0.7, -1, 0, 0]
  for (let n = 0; n < 30; n++) l.step([i], 0.05)
  expect(u.h).toBeLessThan(0); expect(u.v).toBeGreaterThan(0); expect(u.z).toBeLessThan(4)
  const height = u.y
  i.pad!.triggers = [1, 0]; i.pad!.axes = [0, 0, 0, 0]
  for (let n = 0; n < 90; n++) l.step([i], 0.05)
  expect(u.y).toBeLessThan(height); expect(u.ballast).toBeGreaterThan(0.12)
})
it.each([Mode.pad, Mode.tilt])('uses trackpad mode %s for thrust, steering and pan ballast', (mode) => {
  const l = new SubmarineLogic(), i = restInput('face.trackpad', mode)
  i.touching = true; i.pan = [0, -30]
  if (mode === Mode.tilt) i.tilt = [0.7, -0.9]
  else i.drag = [45, -70]
  for (let n = 0; n < 30; n++) { l.step([i], 0.05); i.drag = [0, 0] }
  expect(l.units[0].h).toBeLessThan(0); expect(l.units[0].v).toBeGreaterThan(0); expect(l.units[0].y).toBeGreaterThan(4)
  i.touching = false; i.tilt = [0, 0]; i.pan = [0, 0]
  for (let n = 0; n < 200; n++) l.step([i], 0.05)
  expect(l.units[0].ballast).toBeCloseTo(0.12, 4)
  expect(Math.abs(l.units[0].v)).toBeLessThan(0.001)
})
it.each(['ping', 'pad', 'button'])('sends an expanding sonar pulse using %s', (source) => {
  const l = new SubmarineLogic(), i = restInput('face.trackpad')
  if (source === 'button') i.padPressed = 1 << PadButton.A
  else i.presses = [source]
  l.step([i], 0.05)
  expect(l.units[0].ping).toBeGreaterThan(0); expect(l.units[0].actions).toBe(1)
  expect(l.drain()[0].text).toBe('Sonar ping')
  expect(SUBMARINE_SPEC.buttons?.['key:Space']).toBe('tray:ping')
})
it('discovers wrecks once, only inside the pulse, with an independent score per seat', () => {
  const l = new SubmarineLogic(), i = pad(), u = l.units[0], wreck = SUBMARINE_WRECKS[0]
  Object.assign(u, { x: wreck.x, y: wreck.y + 2, z: wreck.z })
  i.presses = ['ping']; l.step([i], 0.05)
  expect(u.score).toBe(0)
  i.presses = []
  for (let n = 0; n < 40; n++) l.step([i], 0.05)
  expect(u.score).toBe(100); expect(u.found).toBe(1); expect(l.units[1].score).toBe(0)
  i.presses = ['ping']; l.step([i], 0.05); i.presses = []
  for (let n = 0; n < 40; n++) l.step([i], 0.05)
  expect(u.score).toBe(100)
  expect(l.readout(0)).toContain('1/4 wrecks')
  expect(l.drain().filter((e) => e.kind === 'score')).toHaveLength(1)
})
it('anchors sonar to its emission point and rate-limits repeated presses', () => {
  const l = new SubmarineLogic(), i = pad(), u = l.units[0]
  i.presses = ['ping']; l.step([i], 0.05)
  const origin = [u.pingX, u.pingY, u.pingZ]
  u.x = 10
  for (let n = 0; n < 10; n++) l.step([i], 0.05)
  expect([u.pingX, u.pingY, u.pingZ]).toEqual(origin)
  expect(u.actions).toBe(1)
  expect(u.score).toBe(0)
})
it.each([false, true])('trims and coasts to rest after quiet=%s, without retaining stale pad actions', (quiet) => {
  const l = new SubmarineLogic(), i = pad()
  i.pad!.axes = [1, -1, 0, 0]; i.pad!.triggers = [0, 1]
  for (let n = 0; n < 30; n++) l.step([i], 0.05)
  i.quiet = true; i.padPressed = 1 << PadButton.A
  for (let n = 0; n < 300; n++) l.step([quiet ? i : null], 0.05)
  expect(l.units[0].thrust).toBe(0); expect(l.units[0].ballast).toBeCloseTo(0.12, 4)
  expect(Math.hypot(l.units[0].vx, l.units[0].vy, l.units[0].vz)).toBeLessThan(0.001)
  expect(l.units[0].actions).toBe(0)
})
it('keeps the depth and tank limits bounded and Home stops one sub without erasing discoveries', () => {
  const l = new SubmarineLogic(), i = pad(), u = l.units[0]
  i.pad!.axes = [0, -1, 0, 0]; i.pad!.triggers = [0, 1]
  for (let n = 0; n < 1000; n++) l.step([i], 500)
  expect(u.y).toBe(8); expect(u.z).toBeGreaterThanOrEqual(-14); expect(u.v).toBeLessThanOrEqual(2.5)
  i.pad!.triggers = [1, 0]
  for (let n = 0; n < 1000; n++) l.step([i], 0.05)
  expect(u.y).toBe(0.65)
  const x = u.x; l.step([i], Number.NaN); expect(u.x).toBe(x)
  u.score = 100; u.found = 1; const other = { ...l.units[1] }
  l.home(0)
  expect(u).toMatchObject({ x: -1.8, y: 4, z: 4, v: 0, vx: 0, vy: 0, vz: 0, ballast: 0.12, thrust: 0, ping: 0, score: 100, found: 1 })
  expect(l.units[1]).toEqual(other)
})
it('holds neutral trim at Home until old controls release, and accepts fresh input', () => {
  const l = new SubmarineLogic(), i = pad()
  i.pad!.axes[1] = -1; i.pad!.triggers = [0, 1]; l.step([i], 0.05); l.home(0)
  for (let n = 0; n < 20; n++) l.step([i], 0.05)
  expect(l.units[0]).toMatchObject({ x: -1.8, y: 4, z: 4, ballast: 0.12, v: 0 })
  i.pad!.axes[1] = 0; i.pad!.triggers = [0, 0]; l.step([i], 0.05)
  i.pad!.axes[1] = -1; l.step([i], 0.05)
  expect(l.units[0].v).toBeGreaterThan(0)
})
it('allows explicit sonar tray actions while quiet', () => {
  const l = new SubmarineLogic(), i = pad()
  i.quiet = true; i.presses = ['ping']; l.step([i], 0.05)
  expect(l.units[0].actions).toBe(1)
  expect(l.units[0].ping).toBeGreaterThan(0)
})
