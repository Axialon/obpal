import { expect, it } from 'vitest'
import { FOOTBALL, FootballLogic } from '../src/sim/devices/football'
import { restInput } from '../src/sim/devices/types'

it('moves both sticks independently and gives a vacant station to its teammate', () => {
  const l = new FootballLogic(), i = restInput()
  i.pad = { axes: [1, -1, -1, 1], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 }
  l.step([i], 0.05)
  expect(l.rods[0].x).toBeGreaterThan(0)
  expect(l.rods[1].x).toBeLessThan(0)
  expect(l.rods[3].x).toBeGreaterThan(0)
  expect(l.rods[2].x).toBe(0)
  for (let n = 0; n < 200; n++) l.step([i], 0.05)
  expect(l.rods.every(r => Math.abs(r.x) <= 0.3 && Math.abs(r.angle) <= Math.PI)).toBe(true)
})
it('maps drags and pan to separate rods and stops stale spin', () => {
  const l = new FootballLogic(), i = restInput()
  i.drag = [20, -40]; i.pan = [-20, 40]
  l.step([i], 0.05)
  expect(l.rods[0].x).toBeCloseTo(0.12)
  expect(l.rods[1].x).toBeCloseTo(-0.12)
  const before = l.rods.map(r => ({ ...r, spin: 0 }))
  i.quiet = true; l.step([i], 0.05)
  expect(l.rods).toEqual(before)
})
it('kicks with a spinning foot and caps ball speed', () => {
  const l = new FootballLogic(), i = restInput()
  Object.assign(l.ball, { x: 0, z: 1.46, ready: false })
  i.drag = [0, -10]; l.step([i], 0.05)
  expect(l.ball.vz).toBeLessThan(-1)
  expect(Math.hypot(l.ball.vx, l.ball.vz)).toBeLessThanOrEqual(FOOTBALL.speed)
})
it('scores once, preserves the score on Home and isolates a held teammate', () => {
  const l = new FootballLogic(), i = restInput(), idle = restInput()
  i.drag = [30, 0]; l.step([i, null, idle], 0.05)
  expect(l.rods[3].x).toBe(0)
  Object.assign(l.ball, { x: 0, z: -1.65, vz: -3, ready: false }); l.step([], 0.05)
  expect(l.scores).toEqual([1, 0]); l.step([], 0.05)
  expect(l.scores).toEqual([1, 0]); l.home(0)
  expect(l.units[0].x).toBe(0); expect(l.scores[0]).toBe(1)
})

it('kicks toward the opposing goal for either team and serves a stopped ball between rods', () => {
  const l = new FootballLogic(), i = restInput(); i.drag = [0, -10]
  Object.assign(l.ball, { x: 0, z: -1.46, ready: false })
  l.step([null, i], 0.05); expect(l.ball.vz).toBeGreaterThan(1)
  Object.assign(l.ball, { x: 0.5, z: 0, vx: 0.01, vz: 0.01 })
  i.drag = [0, 0]; i.presses = ['serve']; l.step([null, i], 0.05)
  expect(l.ball.x).toBeLessThan(0.1); expect(l.ball.vz).toBeGreaterThan(1)
})
