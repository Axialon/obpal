import { Controller, Mode, checkButtons } from '@obpal/core'
import { describe, expect, it } from 'vitest'
import { AIRHOCKEY, AIRHOCKEY_SPEC, AirhockeyLogic } from '../src/sim/devices/airhockey'
import { restInput } from '../src/sim/devices/types'

describe('air hockey', () => {
  it('offers trackpad first, pointer second and real Serve bindings', () => {
    expect(AIRHOCKEY_SPEC.controllers).toEqual([Controller.trackpad, Controller.mouse])
    for (const face of AIRHOCKEY_SPEC.controllers) expect(checkButtons(face, AIRHOCKEY_SPEC.buttons).errors).toEqual([])
  })

  it('slides a mallet with a drag and confines both players to their own halves', () => {
    const logic = new AirhockeyLogic(), input = restInput(Controller.trackpad, Mode.pad)
    input.drag = [10000, -10000]
    for (let n = 0; n < 20; n++) logic.step([input, input], 0.05)
    expect(logic.units[0].x).toBeCloseTo(AIRHOCKEY.halfWidth - AIRHOCKEY.mallet)
    expect(logic.units[0].z).toBeCloseTo(AIRHOCKEY.mallet)
    expect(logic.units[1].z).toBeCloseTo(-AIRHOCKEY.halfLength + AIRHOCKEY.mallet)
    expect(logic.units.every((u) => Math.hypot(u.vx, u.vz) <= AIRHOCKEY.malletSpeed + 1e-8)).toBe(true)
  })

  it('uses the pointer’s table intersection and rebases it on Home', () => {
    const logic = new AirhockeyLogic(), input = restInput(Controller.mouse, Mode.point)
    input.spot = [0.4, 0.7]
    for (let n = 0; n < 10; n++) logic.step([input], 0.05)
    expect(logic.units[0].x).toBeCloseTo(0.4)
    expect(logic.units[0].z).toBeCloseTo(0.7)
    logic.home(0); logic.step([input], 0.05)
    expect(logic.units[0].x).toBe(0)
    expect(logic.units[0].z).toBe(1.05)
    input.spot = [0.5, 0.6]; logic.step([input], 0.05)
    expect(logic.units[0].x).toBeCloseTo(0.1)
    expect(logic.units[0].z).toBeCloseTo(0.95)
  })

  it('serves once from a tap or explicit action without repeated score growth', () => {
    const logic = new AirhockeyLogic(), input = restInput()
    input.presses = ['pad']
    logic.step([input], 0.05)
    expect(logic.puck.ready).toBe(false)
    expect(logic.puck.vz).toBeLessThan(0)
    expect(logic.units[0].actions).toBe(1)
    logic.step([input], 0.05)
    expect(logic.units[0].actions).toBe(1)
    expect(logic.drain().filter((e) => e.kind === 'tick')).toHaveLength(1)
  })

  it('holds an unchanged pointer steady and accepts a new recentre without a jump', () => {
    const logic = new AirhockeyLogic(), input = restInput(Controller.mouse, Mode.point)
    input.spot = [0.35, 0.65]
    for (let n = 0; n < 30; n++) logic.step([input], 0.05)
    expect(logic.units[0].x).toBeCloseTo(0.35)
    expect(logic.units[0].z).toBeCloseTo(0.65)
    input.spot = [0, 1.05]; input.recentred = true
    logic.step([input], 0.05)
    input.recentred = false
    logic.step([input], 0.05)
    expect(logic.units[0].x).toBe(0)
    expect(logic.units[0].z).toBe(1.05)
    input.spot = null; input.point = { x: 0, y: 0, yaw: 10, pitch: 5, off: false }
    logic.step([input], 0.05)
    logic.home(0); logic.step([input], 0.05)
    expect(logic.units[0].x).toBe(0)
    expect(logic.units[0].z).toBe(1.05)
  })

  it('transfers a moving mallet’s momentum to the puck', () => {
    const logic = new AirhockeyLogic(), input = restInput()
    Object.assign(logic.units[0], { x: 0, z: 0.3, tx: 0, tz: 0.3 })
    Object.assign(logic.puck, { x: 0, z: 0.02, vx: 0, vz: 0, ready: true })
    input.drag = [0, -30]
    logic.step([input], 0.05)
    expect(logic.puck.vz).toBeLessThan(-1)
    expect(logic.units[0].hits).toBe(1)
    expect(logic.puck.ready).toBe(false)
    expect(Math.hypot(logic.puck.vx, logic.puck.vz)).toBeLessThanOrEqual(AIRHOCKEY.puckSpeed)
  })

  it('bounces a fast puck off side rails and end rails outside the goal', () => {
    const logic = new AirhockeyLogic()
    Object.assign(logic.puck, { x: 0.93, z: 0.8, vx: 1000, vz: 0, ready: false })
    logic.step([], 0.05)
    expect(logic.puck.vx).toBeLessThan(0)
    expect(Math.abs(logic.puck.x)).toBeLessThan(AIRHOCKEY.halfWidth)
    Object.assign(logic.puck, { x: 0.6, z: -1.53, vx: 0, vz: -1000 })
    logic.step([], 0.05)
    expect(logic.puck.vz).toBeGreaterThan(0)
    expect(logic.units[0].score).toBe(0)
  })

  it('counts each goal for the opposite end once, then waits for a serve', () => {
    const logic = new AirhockeyLogic()
    Object.assign(logic.puck, { x: 0, z: -1.59, vx: 0, vz: -4, ready: false })
    logic.step([], 0.05)
    expect(logic.units[0].score).toBe(1)
    expect(logic.units[1].score).toBe(0)
    expect(logic.puck.ready).toBe(true)
    for (let n = 0; n < 100; n++) logic.step([], 0.05)
    expect(logic.units[0].score).toBe(1)
    Object.assign(logic.puck, { x: 0, z: 1.59, vx: 0, vz: 4, ready: false })
    logic.step([], 0.05)
    expect(logic.units[1].score).toBe(1)
    expect(logic.drain().filter((e) => e.kind === 'score')).toHaveLength(2)
  })

  it('does not carry stale pointer, drag or target movement through quiet input', () => {
    const logic = new AirhockeyLogic(), input = restInput()
    input.drag = [80, 0]
    logic.step([input], 0.05)
    const x = logic.units[0].x
    input.quiet = true; input.spot = [-0.8, 0.4]; input.presses = ['pad']
    logic.step([input], 0.05)
    expect(logic.units[0].x).toBe(x)
    expect(logic.units[0].vx).toBe(0)
    expect(logic.puck.ready).toBe(true)
    input.presses = ['serve']; logic.step([input], 0.05)
    expect(logic.puck.ready).toBe(false)
  })

  it('homes only one mallet, preserving the other player, the puck and scores', () => {
    const logic = new AirhockeyLogic()
    Object.assign(logic.units[0], { x: 0.7, z: 0.5, score: 2 })
    Object.assign(logic.units[1], { x: -0.6, z: -0.5, score: 3 })
    Object.assign(logic.puck, { x: 0.2, z: 0.3, vx: 1, vz: 2, ready: false })
    logic.home(0)
    expect(logic.units[0].x).toBe(0)
    expect(logic.units[0].z).toBe(1.05)
    expect(logic.units[0].score).toBe(2)
    expect(logic.units[1].x).toBe(-0.6)
    expect(logic.puck.vx).toBe(1)
    expect(logic.puck.x).toBe(0.2)
  })

  it('caps time and speed and remains inside the table through repeated high-speed steps', () => {
    const logic = new AirhockeyLogic()
    for (let n = 0; n < 100; n++) {
      Object.assign(logic.puck, { x: 0.7, z: 0, vx: n % 2 ? 1000 : -1000, vz: n % 3 ? 1000 : -1000, ready: false })
      logic.step([], 10)
      expect(Math.abs(logic.puck.x)).toBeLessThanOrEqual(AIRHOCKEY.halfWidth - AIRHOCKEY.puck)
      expect(Math.abs(logic.puck.z)).toBeLessThanOrEqual(AIRHOCKEY.halfLength + AIRHOCKEY.puck)
      expect(Math.hypot(logic.puck.vx, logic.puck.vz)).toBeLessThanOrEqual(AIRHOCKEY.puckSpeed + 1e-8)
    }
    const before = { ...logic.puck }
    logic.step([], NaN); logic.step([], -4); logic.step([], Infinity)
    expect(logic.puck).toEqual(before)
  })
})
