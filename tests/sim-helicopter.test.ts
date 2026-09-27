import { Mode, PadButton } from '@obpal/core'
import { expect, it } from 'vitest'
import { HelicopterLogic, HELICOPTER_PADS, HELICOPTER_RINGS, HELICOPTER_SPEC } from '../src/sim/devices/helicopter'
import { restInput } from '../src/sim/devices/types'

function pad() {
  const i = restInput()
  i.pad = { axes: [0, 0, 0, 0], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 }
  return i
}
it('takes off with RT, follows cyclic and yaw, and descends with LT', () => {
  const l = new HelicopterLogic(), i = pad(), u = l.units[0]
  i.pad!.triggers[1] = 1
  for (let n = 0; n < 50; n++) l.step([i], 0.05)
  expect(u.y).toBeGreaterThan(1)
  i.pad!.axes = [0.6, 0, 0.7, -0.8]; i.pad!.triggers = [0, 0]
  for (let n = 0; n < 20; n++) l.step([i], 0.05)
  expect(u.x).not.toBe(-2); expect(u.z).not.toBe(4); expect(u.h).toBeLessThan(0)
  expect(u.roll).toBeLessThan(0); expect(u.pitch).toBeLessThan(0)
  const height = u.y
  i.pad!.axes = [0, 0, 0, 0]; i.pad!.triggers = [1, 0]
  for (let n = 0; n < 60; n++) l.step([i], 0.05)
  expect(u.y).toBeLessThan(height)
})
it.each(['fly', 'pad', 'button'])('takes off, hovers and lands using %s', (source) => {
  const l = new HelicopterLogic(), i = restInput('face.trackpad')
  if (source === 'button') i.padPressed = 1 << PadButton.A
  else i.presses = [source]
  l.step([i], 0.05); i.presses = []; i.padPressed = 0
  for (let n = 0; n < 150; n++) l.step([i], 0.05)
  expect(l.units[0].y).toBeCloseTo(1.6, 2)
  expect(l.units[0].flying).toBe(true)
  i.presses = ['fly']; l.step([i], 0.05); i.presses = []
  for (let n = 0; n < 150; n++) l.step([i], 0.05)
  expect(l.units[0].y).toBe(0.22)
  expect(l.units[0].landings).toBe(1)
  expect(l.units[0].actions).toBe(2)
  expect(HELICOPTER_SPEC.buttons?.['media:playpause']).toBe('tray:fly')
})
it.each([Mode.pad, Mode.tilt])('flies from trackpad drag or tilt mode %s with pan collective', (mode) => {
  const l = new HelicopterLogic(), i = restInput('face.trackpad', mode)
  i.presses = ['fly']; i.touching = true; i.pan = [0, -30]
  if (mode === Mode.tilt) i.tilt = [0.8, -0.6]
  else i.drag = [72, -54]
  l.step([i], 0.05); i.drag = [0, 0]; i.presses = []
  for (let n = 0; n < 20; n++) l.step([i], 0.05)
  expect(l.units[0].x).toBeGreaterThan(-2); expect(l.units[0].z).toBeLessThan(4)
  expect(l.units[0].targetY).toBeGreaterThan(1.6)
  i.touching = false; i.tilt = [0, 0]; i.pan = [0, 0]
  for (let n = 0; n < 100; n++) l.step([i], 0.05)
  expect(Math.abs(l.units[0].vx)).toBeLessThan(0.001)
})
it('awards only the next ring on a real plane crossing', () => {
  const l = new HelicopterLogic(), u = l.units[0], i = pad()
  const cross = (n: number) => {
    const r = HELICOPTER_RINGS[n], nx = Math.sin(r.face), nz = Math.cos(r.face)
    Object.assign(u, { x: r.x + nx * 0.01, y: r.y, z: r.z + nz * 0.01, vx: -nx * 2, vz: -nz * 2, targetY: r.y, flying: true })
    l.step([i], 0.05)
  }
  cross(2); expect(u.rings).toBe(0)
  for (let n = 0; n < HELICOPTER_RINGS.length; n++) cross(n)
  expect(u.rings).toBe(4); expect(u.next).toBe(0)
  cross(3); expect(u.rings).toBe(4)
  expect(l.drain().filter((e) => e.kind === 'score')).toHaveLength(4)
})
it.each([false, true])('lands safely and clears latched flight on quiet=%s input', (quiet) => {
  const l = new HelicopterLogic(), i = pad()
  i.pad!.triggers = [0, 1]; i.pad!.axes = [1, 0, 1, -1]
  for (let n = 0; n < 60; n++) l.step([i], 0.05)
  i.quiet = true; i.presses = []; i.padPressed = 1 << PadButton.A
  for (let n = 0; n < 500; n++) l.step([quiet ? i : null], 0.05)
  expect(l.units[0]).toMatchObject({ flying: false, collective: 0, vx: 0, vy: 0, vz: 0, y: 0.22 })
  i.quiet = false; i.presses = []; i.padPressed = 0; i.pad!.axes = [0, 0, 0, 0]; i.pad!.triggers = [0, 0]
  l.step([i], 0.05)
  expect(l.units[0].flying).toBe(false)
})
it('caps the training volume and timestep, and Home clears one unit without erasing scores', () => {
  const l = new HelicopterLogic(), i = pad(), u = l.units[0]
  i.pad!.axes = [0, 0, 1, -1]; i.pad!.triggers = [0, 1]
  for (let n = 0; n < 1000; n++) l.step([i], 200)
  expect(Math.abs(u.x)).toBeLessThanOrEqual(11); expect(Math.abs(u.z)).toBeLessThanOrEqual(10); expect(u.y).toBeLessThanOrEqual(8)
  const x = u.x; l.step([i], Number.POSITIVE_INFINITY); expect(u.x).toBe(x)
  u.rings = 3; l.units[1].rings = 7
  const other = { ...l.units[1] }; l.home(0)
  expect(u).toMatchObject({ x: HELICOPTER_PADS[0][0], z: HELICOPTER_PADS[0][1], y: 0.22, flying: false, next: 0, rings: 3, collective: 0, rotor: 0 })
  expect(l.units[1]).toEqual(other)
})
it('holds at Home until the collective is released, then accepts a fresh climb', () => {
  const l = new HelicopterLogic(), i = pad()
  i.pad!.triggers = [0, 1]; l.step([i], 0.05); l.home(0)
  for (let n = 0; n < 20; n++) l.step([i], 0.05)
  expect(l.units[0]).toMatchObject({ y: 0.22, flying: false })
  i.pad!.triggers = [0, 0]; l.step([i], 0.05)
  i.pad!.triggers = [0, 1]; l.step([i], 0.05)
  expect(l.units[0].flying).toBe(true)
})
it('recognizes explicit quiet tray actions then lands if input remains quiet', () => {
  const l = new HelicopterLogic(), i = pad()
  i.quiet = true; i.presses = ['fly']; l.step([i], 0.05)
  expect(l.units[0].actions).toBe(1)
  i.presses = []; l.step([i], 0.05)
  expect(l.units[0].flying).toBe(false)
})
