import { it, expect } from 'vitest'
import { MarblerunLogic } from '../src/sim/devices/marblerun'
import { advanceStart, releaseTime, startState } from '../src/sim/devices/marblerun.start'
import { CUP } from '../src/sim/physics/marblerun'
import { captureDevice, applyDevice } from '../src/sim/vr/snapshot'
import { restInput } from '../src/sim/devices/types'
import { Mode } from '@obpal/core'

it('waits for staggered releases and real rest instead of snapping on a timer', () => {
  const state = startState()
  expect([0, 1, 2].map(releaseTime)).toEqual([0, .24, .48])
  advanceStart(state, .3, true); expect(state.phase).toBe('feeding')
  advanceStart(state, .3, true); expect(state.phase).toBe('settling')
  advanceStart(state, 2, false); expect(state.phase).toBe('settling')
  advanceStart(state, 1 / 240, true); expect(state.phase).toBe('settled')
})

it('settles the staggered feeder under physics in two and a half seconds without a pop', () => {
  const logic = new MarblerunLogic(), u = logic.units[0]
  let maxJump = 0, previous = logic.renderState()[0].marbles, settledAt = 0, clacks = 0
  const waiting = { ...u.marbles[1] }
  for (let n = 0; n < 600; n++) {
    logic.step([], 1 / 240)
    const next = logic.renderState()[0].marbles
    next.forEach((m, j) => { maxJump = Math.max(maxJump, Math.hypot(m.x - previous[j].x, m.z - previous[j].z)) })
    previous = next
    if (n < 110) expect(u.marbles[1]).toEqual(waiting)
    if (!settledAt && u.start.phase === 'settled') settledAt = (n + 1) / 240
    clacks += logic.drain().filter(e => e.audio?.glass === 'clack').length
  }
  expect(settledAt).toBeGreaterThanOrEqual(1.5); expect(settledAt).toBeLessThanOrEqual(2.5)
  expect(clacks).toBeGreaterThan(0); expect(clacks).toBeLessThan(12)
  expect(maxJump).toBeLessThan(.012)
  for (const m of [u, ...u.marbles]) {
    expect(Math.hypot(m.x - CUP.x, m.z)).toBeLessThan(CUP.inner)
    expect(Math.hypot(m.vx, m.vz)).toBe(0)
  }
  const rest = logic.renderState()
  for (let n = 0; n < 2400; n++) logic.step([], 1 / 240)
  expect(logic.renderState()).toEqual(rest); expect(logic.drain()).toEqual([])
  logic.home(0); expect(u.start.phase).toBe('feeding')
  logic.push(0); expect(u.vx).toBeGreaterThan(0); expect(u.start.phase).toBe('controlled')
})

it('uses a calm static cup for reduced motion and shares entrance state without running a guest clock', () => {
  const calm = new MarblerunLogic(true), rest = calm.renderState()
  calm.step([], 2.5); expect(calm.renderState()).toEqual(rest)
  calm.home(0); expect(calm.units[0].start.phase).toBe('settled')
  const host = new MarblerunLogic(), guest = new MarblerunLogic()
  for (let n = 0; n < 100; n++) host.step([], 1 / 240)
  applyDevice(guest, captureDevice(host))
  expect(guest.renderState()[0].marbles[0]).toMatchObject({ x: host.units[0].x, z: host.units[0].z, rollZ: host.units[0].rollZ })
  expect(guest.units[0].start).toEqual(host.units[0].start)
  expect(guest.physicsDiagnostics().tick).toBe(0)
})

it('lets a build drag select and place immediately with automatic tilt, until Home or recentring', () => {
  const logic = new MarblerunLogic(), u = logic.units[0]
  const input = { ...restInput('face.trackpad', Mode.tilt), space: { aim: [0, 0] as [number, number], tilt: [0, 0] as [number, number], active: true } }
  logic.step([{ ...input, touching: true, drag: [40, 40] }], 1 / 60)
  expect([u.cursorX, u.cursorZ]).toEqual([3, 3])
  expect(u.start.phase).toBe('feeding')
  logic.step([input], 1 / 60)
  expect([u.cursorX, u.cursorZ]).toEqual([3, 3])
  expect(u.track[18]).toBeNull()
  logic.step([{ ...input, presses: ['place'] }], 1 / 60)
  expect(u.track[18]).toEqual({ kind: 0, turn: 0 })
  logic.step([{ ...input, recentred: true }], 1 / 60)
  expect(u.cursorX).toBe(2)
  logic.step([{ ...input, drag: [40, 0] }], 1 / 60)
  logic.home(0)
  logic.step([{ ...input, space: { ...input.space, aim: [-1, 1] } }], 1 / 60)
  expect([u.cursorX, u.cursorZ]).toEqual([0, 0])
})

it('interrupts the feeder on the first push or tilt without discarding the track', () => {
  for (const control of ['push', 'tilt']) {
    const logic = new MarblerunLogic(), u = logic.units[0]
    const track = structuredClone(u.track)
    const input = restInput('face.trackpad', Mode.tilt)
    if (control === 'push') input.presses = ['push']
    else input.tilt = [.8, 0]
    logic.step([input], 1 / 60)
    expect(u.start.phase).toBe('controlled')
    expect(control === 'push' ? u.vx : u.tiltX).toBeGreaterThan(0)
    expect(u.track).toEqual(track)
    logic.home(0)
    expect(u.start.phase).toBe('feeding')
    expect(u.track).toEqual(track)
  }
})
