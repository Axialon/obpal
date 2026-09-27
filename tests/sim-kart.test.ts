import { PadButton } from '@obpal/core'
import { expect, it } from 'vitest'
import { KartLogic, KART_CHECKPOINTS, KART_SPEC, KART_TRACK } from '../src/sim/devices/kart'
import { restInput } from '../src/sim/devices/types'

function pad(face = 'face.gamepad') {
  const i = restInput(face)
  i.pad = { axes: [0, 0, 0, 0], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 }
  return i
}
function gate(l: KartLogic, angle: number, reverse = false) {
  const u = l.units[0], a = angle + (reverse ? 0.015 : -0.015), v = reverse ? -6 : 6
  Object.assign(u, { x: Math.sin(a) * 7.7, z: Math.cos(a) * 7.7, h: a - Math.PI / 2, v, vx: Math.cos(a) * v, vz: -Math.sin(a) * v })
  l.step([null], 0.05)
}
it.each(['face.wheel', 'face.gamepad'])('uses %s steering axes and trigger pedals', (face) => {
  const l = new KartLogic(), i = pad(face)
  i.pad!.axes[0] = 0.8; i.pad!.triggers[1] = 1
  for (let n = 0; n < 30; n++) l.step([i], 0.05)
  expect(l.units[0].v).toBeGreaterThan(0)
  expect(l.units[0].h).not.toBe(-Math.PI / 2)
  expect(l.units[0].x).not.toBe(-0.7)
  l.home(0); l.step([null], 0); i.pad!.triggers = [1, 0]
  for (let n = 0; n < 15; n++) l.step([i], 0.05)
  expect(l.units[0].v).toBeLessThan(0)
})
it('uses gamepad stick power and keeps steering alone still', () => {
  const l = new KartLogic(), i = pad()
  i.pad!.axes[0] = 1
  l.step([i], 0.05)
  expect(l.units[0].v).toBe(0)
  i.pad!.axes[1] = -1
  l.step([i], 0.05)
  expect(l.units[0].v).toBeGreaterThan(0)
})
it.each(['tray', 'pad'])('starts a brief drift through the %s action', (source) => {
  const l = new KartLogic(), i = pad()
  if (source === 'tray') i.presses = ['drift']
  else i.padPressed = 1 << PadButton.A
  l.step([i], 0.05)
  expect(l.units[0].drift).toBeGreaterThan(0)
  expect(l.units[0].actions).toBe(1)
  expect(l.drain()[0].kind).toBe('tick')
  i.presses = []; i.padPressed = 0
  for (let n = 0; n < 30; n++) l.step([i], 0.05)
  expect(l.units[0].drift).toBe(0)
  expect(KART_SPEC.buttons?.['key:Space']).toBe('tray:drift')
})
it('requires all ordered gates before awarding a lap and ranks the race', () => {
  const l = new KartLogic()
  gate(l, Math.PI * 2)
  expect(l.units[0].laps).toBe(0)
  gate(l, KART_CHECKPOINTS[3])
  expect(l.units[0].next).toBe(0)
  for (const a of KART_CHECKPOINTS) gate(l, a)
  expect(l.units[0].laps).toBe(1)
  expect(l.units[0].next).toBe(0)
  expect(l.readout(0)).toContain('#1 · 1 laps')
  l.units[1].laps = 2
  expect(l.leaderboard()[0].unit).toBe(1)
  expect(l.readout(0)).toContain('#2')
})
it('does not count reverse crossings, camping or repeated finish-line crossings', () => {
  const l = new KartLogic()
  gate(l, KART_CHECKPOINTS[0], true)
  expect(l.units[0].next).toBe(0)
  gate(l, KART_CHECKPOINTS[0])
  for (let n = 0; n < 20; n++) { gate(l, KART_CHECKPOINTS[0]); gate(l, Math.PI * 2) }
  expect(l.units[0].next).toBe(1)
  expect(l.units[0].laps).toBe(0)
})
it('contains large timesteps and velocity inside both track edges', () => {
  const l = new KartLogic(), i = pad()
  i.pad!.axes = [1, -1, 0, 0]
  for (let n = 0; n < 1000; n++) {
    l.step([i], 100)
    const u = l.units[0], radius = Math.hypot(u.x, u.z)
    expect(radius).toBeGreaterThanOrEqual(KART_TRACK.inner - 1e-8)
    expect(radius).toBeLessThanOrEqual(KART_TRACK.outer + 1e-8)
    expect(Math.abs(u.v)).toBeLessThanOrEqual(8)
  }
  const before = l.units[0].x
  l.step([i], Number.NaN)
  expect(l.units[0].x).toBe(before)
})
it.each([false, true])('clears held power and drift when input is quiet=%s', (quiet) => {
  const l = new KartLogic(), i = pad()
  i.pad!.axes = [1, -1, 0, 0]; i.pad!.triggers = [0, 1]; i.presses = ['drift']
  l.step([i], 0.05)
  i.quiet = true; i.presses = []
  for (let n = 0; n < 200; n++) l.step([quiet ? i : null], 0.05)
  expect(l.units[0].drift).toBe(0)
  expect(Math.abs(l.units[0].v)).toBeLessThan(0.001)
  expect(l.units[0].actions).toBe(1)
})
it('homes only one kart and restarts its checkpoint sequence without erasing laps', () => {
  const l = new KartLogic(), i = pad()
  l.units[0].laps = 2; l.units[0].next = 6; l.units[1].laps = 3
  i.pad!.triggers = [0, 1]; i.presses = ['drift']; l.step([i], 0.05)
  const other = { ...l.units[1] }
  l.home(0)
  expect(l.units[0]).toMatchObject({ x: -0.7, z: 7, v: 0, vx: 0, vz: 0, drift: 0, next: 0, laps: 2 })
  expect(l.units[1]).toEqual(other)
})
it('holds at Home until the throttle is released, then accepts new movement', () => {
  const l = new KartLogic(), i = pad()
  i.pad!.triggers = [0, 1]; l.step([i], 0.05); l.home(0)
  for (let n = 0; n < 20; n++) l.step([i], 0.05)
  expect(l.units[0]).toMatchObject({ x: -0.7, z: 7, v: 0 })
  i.pad!.triggers = [0, 0]; l.step([i], 0.05)
  i.pad!.triggers = [0, 1]; l.step([i], 0.05)
  expect(l.units[0].v).toBeGreaterThan(0)
})
it('recognizes an explicit tray action while quiet without keeping drift latched', () => {
  const l = new KartLogic(), i = pad()
  i.quiet = true; i.presses = ['drift']; l.step([i], 0.05)
  expect(l.units[0].actions).toBe(1)
  i.presses = []; l.step([i], 0.05)
  expect(l.units[0].drift).toBe(0)
})
