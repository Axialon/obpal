import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { emptyPad, PadButton } from '@obpal/core'
import { addStick, dpadBits, gyroToStick, rumblePattern, shapeStick, STICK, TRIGGER, triggerDepth } from '../src/controller/gamepad'
import { applyGamepad, pressedEdges, type GamepadContext } from '../src/viewer/gamepad-input'

const mag = (v: [number, number]) => Math.hypot(v[0], v[1])
const bit = (b: number) => 1 << b

describe('touch stick shaping', () => {
  it('ignores the deadzone and ramps up smoothly just outside it', () => {
    expect(shapeStick(0, 0)).toEqual([0, 0])
    expect(shapeStick(STICK.dead * 0.9, 0)).toEqual([0, 0])
    expect(shapeStick(0.06, -0.06)).toEqual([0, 0]) // radial, not per axis
    const just = shapeStick(STICK.dead + 0.02, 0)
    expect(just[0]).toBeGreaterThan(0)
    expect(just[0]).toBeLessThan(0.05)
  })

  it('reaches exactly 1 before the rim and clamps beyond it, keeping the direction', () => {
    expect(mag(shapeStick(1 - STICK.outer, 0))).toBeCloseTo(1, 6)
    const far = shapeStick(3, 4)
    expect(mag(far)).toBeCloseTo(1, 6)
    expect(far[0]).toBeCloseTo(0.6, 6)
    expect(far[1]).toBeCloseTo(0.8, 6)
  })

  it('curves the response: finer near the centre, monotonic, linear when the curve is 1', () => {
    const half = shapeStick(0.5, 0, 0.1, 0.1, 1.5)[0]
    expect(half).toBeCloseTo(Math.pow(0.5, 1.5), 6) // (0.5 - 0.1) / 0.8 = 0.5 of the live range
    expect(shapeStick(0.5, 0, 0.1, 0.1, 1)[0]).toBeCloseTo(0.5, 6)
    let prev = 0
    for (let x = 0; x <= 1.2; x += 0.01) {
      const v = shapeStick(x, 0)[0]
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('gyro aim to right stick', () => {
  it('is a full deflection at 180°/s, turning left is stick left and tipping up is stick up', () => {
    const full = gyroToStick(180, 0)
    expect(full[0]).toBe(-1)
    expect(Math.abs(full[1])).toBe(0)
    expect(gyroToStick(-90, 0)[0]).toBeCloseTo(0.5, 6)
    expect(gyroToStick(0, 90)[1]).toBeCloseTo(-0.5, 6) // +Y is down on a gamepad
    expect(gyroToStick(0, 0).map(Math.abs)).toEqual([0, 0])
  })

  it('scales with sensitivity and clamps', () => {
    expect(gyroToStick(-90, 0, 2)[0]).toBeCloseTo(1, 6)
    expect(gyroToStick(-720, 720, 1)).toEqual([1, -1])
    expect(gyroToStick(-45, 0, 0.5)[0]).toBeCloseTo(0.125, 6)
  })

  it('adds to the thumb, never past a full deflection', () => {
    expect(addStick([0.2, 0], [0.3, 0])).toEqual([0.5, 0])
    const sum = addStick([0.8, 0], [0.5, 0.2])
    expect(mag(sum)).toBeCloseTo(1, 6)
    expect(sum[1]).toBeGreaterThan(0)
    expect(addStick([0.5, 0], [-0.5, 0])).toEqual([0, 0])
  })
})

describe('analog trigger press depth', () => {
  const top = 100
  const h = 60
  it('a touch at the top is a light pull that still counts as pressed', () => {
    expect(triggerDepth(top, top, h)).toBeCloseTo(TRIGGER.floor, 6)
    expect(triggerDepth(top - 20, top, h)).toBeCloseTo(TRIGGER.floor, 6)
    expect(TRIGGER.floor).toBeGreaterThan(0.12) // the Gamepad API's usual pressed threshold
  })

  it('sliding down pulls harder; a full press is 1, even past the bottom edge', () => {
    const mid = triggerDepth(top + h * TRIGGER.travel * 0.5, top, h)
    expect(mid).toBeCloseTo(TRIGGER.floor + (1 - TRIGGER.floor) * 0.5, 6)
    expect(triggerDepth(top + h * TRIGGER.travel, top, h)).toBe(1)
    expect(triggerDepth(top + h * 3, top, h)).toBe(1)
    let prev = 0
    for (let y = top - 10; y <= top + h + 10; y += 2) {
      const v = triggerDepth(y, top, h)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('D-pad directions', () => {
  it('maps cardinals and diagonals, with a dead centre', () => {
    expect(dpadBits(30, 0, 10)).toBe(bit(PadButton.Right))
    expect(dpadBits(0, -30, 10)).toBe(bit(PadButton.Up))
    expect(dpadBits(-30, 2, 10)).toBe(bit(PadButton.Left))
    expect(dpadBits(0, 30, 10)).toBe(bit(PadButton.Down))
    expect(dpadBits(-20, 20, 10)).toBe(bit(PadButton.Down) | bit(PadButton.Left))
    expect(dpadBits(20, -20, 10)).toBe(bit(PadButton.Up) | bit(PadButton.Right))
    expect(dpadBits(3, 3, 10)).toBe(0)
  })

  it('keeps diagonals narrower than cardinals', () => {
    const at = (deg: number) => dpadBits(Math.cos((deg * Math.PI) / 180) * 40, Math.sin((deg * Math.PI) / 180) * 40, 10)
    expect(at(25)).toBe(bit(PadButton.Right)) // still a plain right
    expect(at(45)).toBe(bit(PadButton.Right) | bit(PadButton.Down))
    expect(at(65)).toBe(bit(PadButton.Down))
  })
})

describe('rumble on Android', () => {
  it('stops below the threshold, buzzes for the strong motor, pulses for the weak one', () => {
    expect(rumblePattern(0.05, 0.1, 300)).toBe(0)
    expect(rumblePattern(1, 0, 0)).toBe(0)
    expect(rumblePattern(0.6, 0.2, 250)).toBe(250)
    const weak = rumblePattern(0, 0.5, 300) as number[]
    expect(Array.isArray(weak)).toBe(true)
    expect(weak.length % 2).toBe(1) // ends on a buzz, not a pause
    const total = weak.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(250)
    expect(total).toBeLessThanOrEqual(300)
  })

  it('keeps long patterns short enough for the browser', () => {
    const long = rumblePattern(0, 1, 5000) as number[]
    expect(long.length).toBeLessThan(100)
    expect(long.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5000)
  })
})

function viewer() {
  const ctx = {
    controls: { distance: 6, rotate: vi.fn(), dolly: vi.fn() },
    camera: new THREE.PerspectiveCamera(),
    holder: new THREE.Object3D(),
    frame: vi.fn(),
    reset: vi.fn(),
    step: vi.fn(),
    toggle: vi.fn(),
    toggleCatalog: vi.fn(),
  }
  return ctx satisfies GamepadContext
}

describe('viewer button edges', () => {
  it('pressedEdges reports only buttons that just went down', () => {
    expect(pressedEdges(0, 0b101)).toBe(0b101)
    expect(pressedEdges(0b101, 0b101)).toBe(0)
    expect(pressedEdges(0b101, 0b110)).toBe(0b010)
    expect(pressedEdges(0, bit(PadButton.Guide))).toBe(bit(PadButton.Guide))
  })

  it('a held button acts once; pressing again acts again', () => {
    const ctx = viewer()
    const pad = emptyPad()
    pad.buttons = bit(PadButton.A)
    for (let i = 0; i < 5; i++) applyGamepad(pad, 1 / 60, ctx)
    expect(ctx.frame).toHaveBeenCalledTimes(1)
    pad.buttons = 0
    applyGamepad(pad, 1 / 60, ctx)
    pad.buttons = bit(PadButton.A)
    applyGamepad(pad, 1 / 60, ctx)
    expect(ctx.frame).toHaveBeenCalledTimes(2)
  })

  it('maps every button to its view action', () => {
    const ctx = viewer()
    const pad = emptyPad()
    const press = (b: number) => { pad.buttons = bit(b); applyGamepad(pad, 1 / 60, ctx); pad.buttons = 0; applyGamepad(pad, 1 / 60, ctx) }
    press(PadButton.B)
    expect(ctx.reset).toHaveBeenCalledTimes(1)
    press(PadButton.X)
    press(PadButton.Y)
    press(PadButton.View)
    expect(ctx.toggle.mock.calls.map((c) => c[0])).toEqual(['spin', 'glow', 'grid'])
    press(PadButton.Menu)
    expect(ctx.toggleCatalog).toHaveBeenCalledTimes(1)
    press(PadButton.LB)
    press(PadButton.Left)
    press(PadButton.RB)
    press(PadButton.Right)
    expect(ctx.step.mock.calls.map((c) => c[0])).toEqual([-1, -1, 1, 1])
    press(PadButton.Up)
    press(PadButton.Down)
    const [zin, zout] = ctx.controls.dolly.mock.calls.map((c) => c[0] as number)
    expect(zin).toBeGreaterThan(0) // dolly in
    expect(zout).toBeLessThan(0)
    expect(6 - zin).toBeCloseTo(6 / 1.2, 6) // one step in, then one step out, are the same ratio
    expect(6 - zout).toBeCloseTo(6 * 1.2, 6)
  })

  it('sticks and triggers act continuously', () => {
    const ctx = viewer()
    const pad = emptyPad()
    pad.axes = [1, 0, 0, 0] // left stick right: the camera orbits so the model turns the stick's way
    applyGamepad(pad, 0.1, ctx)
    expect(ctx.controls.rotate).toHaveBeenCalledTimes(1)
    expect(ctx.controls.rotate.mock.calls[0][0]).toBeLessThan(0)
    pad.axes = [0, 0, 1, 0] // right stick right: the model turns about world up
    applyGamepad(pad, 0.1, ctx)
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(ctx.holder.quaternion)
    expect(front.x).toBeGreaterThan(0.2)
    expect(front.y).toBeCloseTo(0, 6)
    pad.axes = [0, 0, 0, 0]
    pad.triggers = [0, 1] // RT dollies in
    applyGamepad(pad, 0.1, ctx)
    pad.triggers = [1, 0] // LT dollies out
    applyGamepad(pad, 0.1, ctx)
    const [zin, zout] = ctx.controls.dolly.mock.calls.map((c) => c[0] as number)
    expect(zin).toBeGreaterThan(0)
    expect(zout).toBeLessThan(0)
    pad.triggers = [0, 0]
    applyGamepad(pad, 0.1, ctx)
    expect(ctx.controls.dolly).toHaveBeenCalledTimes(2)
    expect(ctx.controls.rotate).toHaveBeenCalledTimes(1)
  })
})
