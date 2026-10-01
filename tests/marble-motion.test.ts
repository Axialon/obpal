import { expect, it } from 'vitest'
import { MarblerunLogic, inChannel } from '../src/sim/devices/marblerun'
import { CUP, collideMarbles, cupSurface } from '../src/sim/physics/marblerun'
import { restInput } from '../src/sim/devices/types'
import { applyDevice, captureDevice } from '../src/sim/vr/snapshot'

const dt = 1 / 240
function flat() {
  const logic = new MarblerunLogic(true), u = logic.units[0]
  u.track[12] = { kind: 0, turn: 0 }
  u.x = -.6; u.marbles[0].x = .4; u.marbles[1].x = .8
  return { logic, u }
}

it('decays a rolling impulse monotonically with bounded acceleration and no velocity snap', () => {
  const { logic, u } = flat()
  logic.push(0, .25); u.spinX = u.vx
  let previous = u.vx, maximumAcceleration = 0
  for (let n = 0; n < 4800; n++) {
    logic.step([], dt)
    maximumAcceleration = Math.max(maximumAcceleration, Math.abs(u.vx - previous) / dt)
    expect(u.vx).toBeGreaterThan(0)
    expect(u.vx).toBeLessThanOrEqual(previous)
    previous = u.vx
  }
  expect(maximumAcceleration).toBeLessThan(.4)
  expect(u.vx).toBeLessThan(1e-9)
})

it('returns through damped oscillations under the visible cup profile', () => {
  const { logic, u } = flat(); u.x = CUP.x
  logic.push(0, .18)
  const peaks: number[] = []; let sign = 1, peak = 0
  for (let n = 0; n < 4800; n++) {
    logic.step([], dt)
    const displacement = u.x - CUP.x, next = Math.sign(displacement)
    peak = Math.max(peak, Math.abs(displacement))
    if (next && next !== sign) { peaks.push(peak); peak = 0; sign = next }
    expect(Math.abs(displacement)).toBeLessThan(CUP.inner)
  }
  expect(peaks.length).toBeGreaterThan(5)
  for (let n = 1; n < peaks.length; n++) expect(peaks[n]).toBeLessThan(peaks[n - 1])
  expect(Math.abs(u.x - CUP.x)).toBeLessThan(1e-6)
  expect(Math.abs(u.vx)).toBeLessThan(1e-6)
  const x = CUP.x + .07, epsilon = 1e-6
  expect(cupSurface(x, 0).gx).toBeCloseTo((cupSurface(x + epsilon, 0).height - cupSurface(x - epsilon, 0).height) / (2 * epsilon), 6)
  expect(cupSurface(CUP.x + CUP.outer, 0)).toEqual({ height: 0, gx: 0, gz: 0 })
})

it('adds twenty rapid click impulses without resetting velocity and keeps energy and contacts bounded', () => {
  const { logic, u } = flat(); u.x = CUP.x; u.running = true
  const input = restInput(); input.presses = ['place']
  let maxEnergy = 0, clacks = 0
  for (let n = 0; n < 2400; n++) {
    const click = n < 480 && n % 24 === 0
    if (click) {
      const before = u.vx; logic.step([input], 0)
      expect(u.vx).toBeGreaterThanOrEqual(before)
    }
    logic.step([], dt)
    for (const m of [u, ...u.marbles]) {
      expect([m.x, m.z, m.vx, m.vz, m.rollX, m.rollZ, m.slip].every(Number.isFinite)).toBe(true)
      expect(inChannel(u.track, m.x, m.z, m.radius)).toBe(true)
    }
    maxEnergy = Math.max(maxEnergy, [u, ...u.marbles].reduce((sum, m) => sum + .5 * m.mass * (m.vx ** 2 + m.vz ** 2 + .4 * (m.spinX ** 2 + m.spinZ ** 2)), 0))
    clacks += logic.drain().filter(e => e.audio?.glass === 'clack').length
  }
  expect(maxEnergy).toBeLessThan(10)
  expect(clacks).toBeGreaterThan(0)
  expect(clacks).toBeLessThan(80)
})

it('conserves two-sphere momentum and uses glass restitution at a collision', () => {
  const { u } = flat(), q = u.marbles[0]
  Object.assign(u, { vx: 1.2, vz: .3 }); Object.assign(q, { vx: -.4, vz: -.2 })
  const px = u.mass * u.vx + q.mass * q.vx, pz = u.mass * u.vz + q.mass * q.vz
  expect(collideMarbles(u, q, 1, 0)).toBeCloseTo(1.6)
  expect(u.mass * u.vx + q.mass * q.vx).toBeCloseTo(px, 12)
  expect(u.mass * u.vz + q.mass * q.vz).toBeCloseTo(pz, 12)
  expect(q.vx - u.vx).toBeCloseTo(.78 * 1.6, 12)
})

it('keeps a resting cup and a touching flat queue exactly still without contact chatter', () => {
  const logic = new MarblerunLogic(true), u = logic.units[0], q = u.marbles[0], r = u.marbles[1]
  q.x = -.6; r.x = q.x + q.radius + r.radius
  const initial = logic.renderState()
  for (let n = 0; n < 2400; n++) logic.step([], dt)
  expect(logic.renderState()).toEqual(initial)
  expect(logic.drain()).toHaveLength(0)
  expect(logic.physicsDiagnostics().sleeping).toBe(6)
})

it('substeps fast marbles, interpolates fixed ticks and preserves shared guest presentation', () => {
  const { logic, u } = flat()
  u.vx = 20
  for (let n = 0; n < 100; n++) {
    logic.step([], dt)
    expect(inChannel(u.track, u.x, u.z, u.radius)).toBe(true)
    expect(Number.isFinite(u.vx)).toBe(true)
  }
  const before = u.x
  logic.step([], dt * 1.5)
  const pose = logic.renderState()[0].marbles[0]
  expect(pose.x).toBeGreaterThanOrEqual(Math.min(before, u.x))
  expect(pose.x).toBeLessThanOrEqual(Math.max(before, u.x))
  const guest = new MarblerunLogic(true), reference = guest.units[0].marbles[0]
  applyDevice(guest, captureDevice(logic))
  expect(guest.units[0].marbles[0]).toBe(reference)
  expect(guest.renderState()[0].marbles[0]).toMatchObject({ x: u.x, z: u.z, rollX: u.rollX, rollZ: u.rollZ })
  expect(guest.physicsDiagnostics().tick).toBe(0)
})

it('keeps moving through Run/build and finishing, with Home as the deliberate reset', () => {
  const { logic, u } = flat(); u.vx = .4; u.spinX = .4
  const input = restInput(); input.presses = ['run']
  const x = u.x; logic.step([input], dt)
  expect(u.x).toBeGreaterThan(x); expect(u.vx).toBeGreaterThan(.39)
  Object.assign(u, { x: 1.04, vx: .4 }); input.presses = []
  logic.step([input], dt)
  expect(u.finished).toBe(true); expect(u.vx).toBeGreaterThan(.39)
  logic.home(0)
  expect(logic.renderState()[0].marbles[0]).toMatchObject({ x: CUP.x, z: 0, rollX: 0, rollZ: 0 })
  expect(u.vx).toBe(0)
})
