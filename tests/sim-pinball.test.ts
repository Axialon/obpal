import { Controller, Mode, PadButton, checkButtons, emptyPad, offerOf, resolveButtons } from '@obpal/core'
import { describe, expect, it } from 'vitest'
import { PINBALL, PINBALL_SPEC, PinballLogic, flipper } from '../src/sim/devices/pinball'
import { layoutOf, restInput } from '../src/sim/devices/types'

describe('pinball', () => {
  it('binds Nudge through real catalogue inputs on both controllers', () => {
    const layout = layoutOf(PINBALL_SPEC)
    for (const face of PINBALL_SPEC.controllers) {
      expect(checkButtons(face, layout.buttons).errors).toEqual([])
      const bindings = resolveButtons(face, [layout.buttons], offerOf(layout))
      expect(bindings['key:KeyN']).toBe('tray:nudge')
      expect(bindings['pad:b3']).toBe('tray:nudge')
    }
    expect(PINBALL_SPEC.controllers[0]).toBe(Controller.gamepad)
  })

  it('pulls and releases the analogue plunger with variable strength', () => {
    const fire = (power: number) => {
      const logic = new PinballLogic(), input = restInput()
      input.pad = emptyPad(); input.pad.triggers[1] = power
      logic.step([input], 0.05)
      expect(logic.units[0].plunger).toBe(power)
      expect(logic.units[0].active).toBe(false)
      input.pad.triggers[1] = 0
      logic.step([input], 0.01)
      expect(logic.units[0].active).toBe(true)
      expect(logic.units[0].balls).toBe(1)
      return -logic.units[0].vz
    }
    expect(fire(0.9)).toBeGreaterThan(fire(0.2) + 2)
  })

  it('launches with a downward trackpad pull and lift, and taps both flippers', () => {
    const logic = new PinballLogic(), input = restInput(Controller.trackpad, Mode.pad)
    input.touching = true; input.drag = [0, 80]
    logic.step([input], 0.05)
    expect(logic.units[0].plunger).toBe(0.5)
    input.touching = false; input.drag = [0, 0]
    logic.step([input], 0.05)
    expect(logic.units[0].active).toBe(true)
    input.presses = ['pad']
    logic.step([input], 0.05)
    expect(logic.units[0].left).toBeGreaterThan(0.5)
    expect(logic.units[0].right).toBeGreaterThan(0.5)
  })

  it('moves each flipper independently from held shoulders and releases it', () => {
    const logic = new PinballLogic(), input = restInput()
    input.pad = emptyPad(); input.pad.buttons = 1 << PadButton.LB
    logic.step([input], 0.05)
    expect(logic.units[0].left).toBe(0.8)
    expect(logic.units[0].right).toBe(0)
    input.pad.buttons = 1 << PadButton.RB
    logic.step([input], 0.05)
    expect(logic.units[0].left).toBe(0)
    expect(logic.units[0].right).toBe(0.8)
    logic.step([], 0.05)
    expect(logic.units[0].right).toBe(0)
    expect(flipper(-1, 1)[3]).toBeLessThan(flipper(-1, 0)[3])
  })

  it('turns a quick Tilt reversal into one bounded cabinet nudge', () => {
    const logic = new PinballLogic(), input = restInput(Controller.trackpad, Mode.tilt)
    input.tilt = [0.9, 0]
    logic.step([input], 0.05)
    expect(logic.units[0].actions).toBe(0)
    input.tilt = [-0.9, 0]
    logic.step([input], 0.05)
    expect(logic.units[0].actions).toBe(1)
    expect(logic.units[0].nudge).toBe(1)
    for (let n = 0; n < 5; n++) { input.tilt[0] *= -1; logic.step([input], 0.05) }
    expect(logic.units[0].actions).toBe(1)
    expect(logic.drain()).toHaveLength(1)
  })

  it('does not recognise a slow tilt, quiet input or Home as a shake', () => {
    const logic = new PinballLogic(), input = restInput(Controller.trackpad, Mode.tilt)
    input.tilt = [0.9, 0]; logic.step([input], 0.05)
    for (let n = 0; n < 10; n++) logic.step([input], 0.05)
    input.tilt = [-0.9, 0]; logic.step([input], 0.05)
    expect(logic.units[0].actions).toBe(0)
    input.quiet = true; input.tilt = [0.9, 0]; logic.step([input], 0.05)
    input.quiet = false; logic.step([input], 0.05)
    expect(logic.units[0].actions).toBe(0)
    logic.home(0); input.tilt = [-0.9, 0]; logic.step([input], 0.05)
    expect(logic.units[0].actions).toBe(0)
  })

  it('scores one physical bumper hit and bounds its rebound', () => {
    const logic = new PinballLogic(), u = logic.units[0]
    Object.assign(u, { active: true, x: -0.28, z: -0.84, vx: 0, vz: 5 })
    logic.step([], 0.02)
    expect(u.score).toBe(100)
    expect(u.vz).toBeLessThan(0)
    expect(logic.drain().filter((e) => e.kind === 'score')).toHaveLength(1)
  })

  it('makes an active flipper hit the ball back up the field', () => {
    const logic = new PinballLogic(), input = restInput(), u = logic.units[0]
    const [ax, az, bx, bz] = flipper(-1, 1)
    Object.assign(u, { active: true, x: (ax + bx) / 2, z: (az + bz) / 2 - 0.065, vx: 0, vz: 1, left: 1 })
    input.pad = emptyPad(); input.pad.buttons = 1 << PadButton.LB
    logic.step([input], 0.01)
    expect(u.vz).toBeLessThan(-4)
  })

  it('drains through the centre and keeps each table score independent', () => {
    const logic = new PinballLogic(), u = logic.units[0]
    Object.assign(u, { active: true, x: 0, z: 1.24, vx: 0, vz: 3, score: 400 })
    logic.units[1].score = 900
    logic.step([], 0.05)
    expect(u.active).toBe(false)
    expect(u.x).toBe(PINBALL.lane)
    expect(u.score).toBe(400)
    expect(logic.units[1].score).toBe(900)
    expect(logic.drain().some((e) => e.kind === 'fall')).toBe(true)
  })

  it('never tunnels out of the cabinet on large frames and high velocities', () => {
    const logic = new PinballLogic(), u = logic.units[0]
    for (let n = 0; n < 100; n++) {
      Object.assign(u, { active: true, x: 0.3, z: 0, vx: n % 2 ? 1000 : -1000, vz: n % 3 ? 1000 : -1000 })
      logic.step([], n % 2 ? 30 : 0.05)
      expect(Math.abs(u.x)).toBeLessThanOrEqual(PINBALL.halfWidth - PINBALL.ball)
      expect(Math.abs(u.z)).toBeLessThanOrEqual(PINBALL.halfLength - PINBALL.ball)
      expect(Math.hypot(u.vx, u.vz)).toBeLessThanOrEqual(PINBALL.maxSpeed + 1e-8)
    }
  })

  it('cancels a held pull on quiet or missing input without firing and homes only one table', () => {
    const logic = new PinballLogic(), input = restInput()
    input.pad = emptyPad(); input.pad.triggers[1] = 1; input.pad.buttons = 1 << PadButton.LB
    logic.step([input], 0.05)
    input.quiet = true; input.presses = ['pad']
    logic.step([input], 0.05)
    expect(logic.units[0].active).toBe(false)
    expect(logic.units[0].plunger).toBe(0)
    expect(logic.units[0].left).toBe(0)
    input.presses = ['launch']; logic.step([input], 0.05)
    expect(logic.units[0].active).toBe(true)
    logic.units[0].score = 400; logic.units[1].score = 900; logic.units[1].x = 0.2
    logic.home(0)
    expect(logic.units[0].score).toBe(400)
    expect(logic.units[0].active).toBe(false)
    expect(logic.units[1].x).toBe(0.2)
    expect(logic.units[1].score).toBe(900)
    expect(logic.readout(0)).toContain('400 points')
  })

  it('requires held triggers and flippers to return to neutral after Home', () => {
    const logic = new PinballLogic(), input = restInput(), u = logic.units[0]
    input.pad = emptyPad(); input.pad.triggers[1] = 0.8
    input.pad.buttons = (1 << PadButton.LB) | (1 << PadButton.RB)
    logic.step([input], 0.05)
    logic.home(0)
    for (let n = 0; n < 5; n++) logic.step([input], 0.05)
    expect(u.plunger).toBe(0)
    expect(u.left).toBe(0)
    expect(u.right).toBe(0)
    input.pad.triggers[1] = 0; input.pad.buttons = 0
    logic.step([input], 0.05)
    expect(u.active).toBe(false)
    input.pad.triggers[1] = 0.6; input.pad.buttons = 1 << PadButton.LB
    logic.step([input], 0.05)
    expect(u.plunger).toBe(0.6)
    expect(u.left).toBeGreaterThan(0)
    input.pad.triggers[1] = 0
    logic.step([input], 0.05)
    expect(u.active).toBe(true)
  })

  it('requires a held touch pull to lift after Home, then launches only from a fresh pull', () => {
    const logic = new PinballLogic(), input = restInput(Controller.trackpad, Mode.pad), u = logic.units[0]
    input.touching = true; input.drag = [0, 80]
    logic.step([input], 0.05)
    logic.home(0)
    for (let n = 0; n < 5; n++) logic.step([input], 0.05)
    expect(u.plunger).toBe(0)
    input.touching = false; input.drag = [0, 0]
    logic.step([input], 0.05)
    expect(u.active).toBe(false)
    input.touching = true; input.drag = [0, 80]
    logic.step([input], 0.05)
    expect(u.plunger).toBe(0.5)
    input.touching = false; input.drag = [0, 0]
    logic.step([input], 0.05)
    expect(u.active).toBe(true)
  })
})
