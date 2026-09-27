import { expect, it } from 'vitest'
import { Mode } from '@obpal/core'
import { MarblerunLogic, inChannel } from '../src/sim/devices/marblerun'
import { restInput } from '../src/sim/devices/types'

it('builds a missing channel, rotates bends and confines the cursor', () => {
  const l = new MarblerunLogic(), i = restInput()
  expect(inChannel(l.units[0].track, 0, 0)).toBe(false)
  i.presses = ['place']; l.step([i], 0.05)
  expect(inChannel(l.units[0].track, 0, 0)).toBe(true)
  i.presses = ['turn', 'piece', 'place']; l.step([i], 0.05)
  expect(l.units[0].track[12]).toEqual({ kind: 1, turn: 1 })
  i.presses = []; i.drag = [10000, -10000]; l.step([i], 0.05)
  expect([l.units[0].cursorX, l.units[0].cursorZ]).toEqual([4, 0])
  expect(l.units[1].track[12]).toBeNull()
})
it('requires a connected track, then finishes a tilt run and retains its best time', () => {
  const l = new MarblerunLogic(), i = restInput('face.trackpad', Mode.tilt)
  i.presses = ['run']; l.step([i], 0.05); i.presses = []; i.tilt = [1, 0]
  for (let n = 0; n < 120; n++) l.step([i], 0.05)
  expect(l.units[0].x).toBeLessThan(-0.28); expect(l.units[0].best).toBe(0)
  l.home(0); i.tilt = [0, 0]; i.presses = ['place']; l.step([i], 0.05)
  i.presses = ['run']; l.step([i], 0.05); i.presses = []; i.tilt = [1, 0]
  for (let n = 0; n < 180; n++) l.step([i], 0.05)
  expect(l.units[0].finished).toBe(true); expect(l.units[0].best).toBeGreaterThan(0)
  const best = l.units[0].best; l.home(0); expect(l.units[0].best).toBe(best)
})
it('stops a disconnected marble and clock and keeps motion inside the channel', () => {
  const l = new MarblerunLogic(), i = restInput()
  l.units[0].running = true; i.drag = [30, 80]; l.step([i], 0.05)
  i.quiet = true; const { x, z, time } = l.units[0]; l.step([i], 9)
  expect(l.units[0]).toMatchObject({ x, z, time, vx: 0, vz: 0 })
  expect(inChannel(l.units[0].track, x, z)).toBe(true)
})

it('limits a short track to ten pieces, permits removal and protects its start and finish', () => {
  const l = new MarblerunLogic(), i = restInput(); i.presses = ['place']
  for (let n = 0; n < 25; n++) { l.units[0].cursorX = n % 5; l.units[0].cursorZ = Math.floor(n / 5); l.step([i], 0.05) }
  expect(l.units[0].track.filter(Boolean)).toHaveLength(10)
  l.units[0].cursorX = 0; l.units[0].cursorZ = 0; i.presses = ['remove']; l.step([i], 0.05)
  expect(l.units[0].track.filter(Boolean)).toHaveLength(9)
  l.units[0].cursorZ = 2; l.step([i], 0.05); expect(l.units[0].track[10]).not.toBeNull()
})
