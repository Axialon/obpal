import { describe, expect, it } from 'vitest'
import { Mode, PadButton, qAxisAngle } from '@obpal/core'
import { panTiltOf } from '../src/sim/devices/input'
import { aimAt, offCentre, PTZ, PtzLogic, ptzControl, stepCam } from '../src/sim/devices/ptz'
import { restInput, type DeviceInput } from '../src/sim/devices/types'
const D2R = Math.PI / 180
const pad = (axes: [number, number, number, number], triggers: [number, number] = [0, 0], buttons = 0) => ({ flags: 0, seq: 0, t: 0, buttons, axes, triggers })
const pointing = (yaw: number, pitch: number, over: Partial<DeviceInput> = {}): DeviceInput => ({ ...restInput('face.wii', Mode.point), point: { x: 0, y: 0, yaw, pitch, off: false }, ...over })
const settle = (logic: PtzLogic, inp: (n: number) => DeviceInput | null, s = 2) => { for (let t = 0; t < s; t += 1 / 60) logic.step(logic.cams.map((_, n) => inp(n)), 1 / 60) }

describe('PTZ camera: each controller aims it', () => {
  it('Wii remote: the camera looks where the phone points, from centre; ⌂ (aim back to 0) is centre again', () => {
    const logic = new PtzLogic(1)
    const c = logic.cams[0]
    settle(logic, () => pointing(10, 5))
    expect((c.home[0] - c.pan) / D2R).toBeCloseTo(10 * PTZ.gain / Math.sqrt(c.zoom), 0)
    expect((c.tilt - c.home[1]) / D2R).toBeCloseTo(5 * PTZ.gain / Math.sqrt(c.zoom), 0)
    settle(logic, () => pointing(0, 0))
    expect(c.pan).toBeCloseTo(c.home[0], 3)
    expect(c.tilt).toBeCloseTo(c.home[1], 3)
  })

  it('− and + zoom, the air mouse’s wheel zooms, A or Left takes a picture', () => {
    const logic = new PtzLogic(1)
    const c = logic.cams[0]
    const z0 = c.zoom
    logic.step([pointing(0, 0, { presses: ['wii-plus'] })], 1 / 60)
    expect(c.zoom).toBeCloseTo(z0 * 1.25)
    logic.step([pointing(0, 0, { face: 'face.mouse', wheel: -1200 })], 1 / 60)
    expect(c.zoom).toBeCloseTo(z0 * 2.5)
    logic.step([pointing(0, 0, { presses: ['wii-a'] })], 1 / 60)
    logic.step([pointing(0, 0, { face: 'face.mouse', presses: ['mouse-left'] })], 1 / 60)
    expect(c.shots).toBe(2)
    expect(logic.drain().length).toBe(2)
  })

  it('trackpad: dragging turns it (less when zoomed in), pinching zooms, a tap takes a picture', () => {
    const logic = new PtzLogic(1)
    const c = logic.cams[0]
    const g0 = c.goal[0]
    ptzControl(c, { ...restInput('face.trackpad', Mode.hold), touching: true, drag: [100, 0] }, 1 / 60)
    expect(c.goal[0]).toBeCloseTo(g0 - 100 * PTZ.drag / c.zoom)
    ptzControl(c, { ...restInput('face.trackpad', Mode.hold), pinch: 1 }, 1 / 60)
    expect(c.zoom).toBeCloseTo(2.8)
    expect(ptzControl(c, { ...restInput('face.trackpad', Mode.hold), presses: ['pad'] }, 1 / 60)).toBe(true)
  })

  it('trackpad 1:1 (gyro on): it turns as the phone turns, from where it was aiming', () => {
    const logic = new PtzLogic(1)
    const c = logic.cams[0]
    const g = [...c.goal]
    ptzControl(c, { ...restInput('face.trackpad', Mode.hold), hold: [0, 0, 0, 1] }, 1 / 60)
    ptzControl(c, { ...restInput('face.trackpad', Mode.hold), hold: qAxisAngle(0, 1, 0, 20 * D2R) }, 1 / 60)
    expect((c.goal[0] - g[0]) / D2R).toBeCloseTo(20, 1)
    expect(panTiltOf(qAxisAngle(1, 0, 0, 15 * D2R))[1] / D2R).toBeCloseTo(15, 3)
  })

  it('gamepad: the right stick turns it, the triggers zoom, A takes a picture', () => {
    const logic = new PtzLogic(1)
    const c = logic.cams[0]
    const g0 = c.goal[0]
    const z0 = c.zoom
    settle(logic, () => ({ ...restInput(), pad: pad([0, 0, 1, 0], [0, 1]) }), 0.5)
    expect(c.goal[0]).toBeLessThan(g0 - 0.1)
    expect(c.zoom).toBeGreaterThan(z0 * 1.3)
    logic.step([{ ...restInput(), pad: pad([0, 0, 0, 0]), padPressed: 1 << PadButton.A }], 1 / 60)
    expect(c.shots).toBe(1)
  })
})

describe('PTZ camera: within its limits', () => {
  it('never turns past its stops or faster than its head, and zooms only 1× to 8×', () => {
    const logic = new PtzLogic(1)
    const c = logic.cams[0]
    let last = { pan: c.pan, tilt: c.tilt }
    for (let t = 0; t < 4; t += 1 / 60) {
      logic.step([pointing(200, -200, { presses: ['wii-plus', 'wii-plus'] })], 1 / 60)
      expect(Math.abs(c.pan - last.pan)).toBeLessThanOrEqual(PTZ.panRate / 60 + 1e-9)
      expect(Math.abs(c.tilt - last.tilt)).toBeLessThanOrEqual(PTZ.tiltRate / 60 + 1e-9)
      last = { pan: c.pan, tilt: c.tilt }
    }
    expect(Math.abs(c.pan)).toBeLessThanOrEqual(PTZ.pan + 1e-9)
    expect(c.tilt).toBeGreaterThanOrEqual(PTZ.tiltDown - 1e-9)
    expect(c.zoom).toBe(PTZ.zoomMax)
  })

  it('a picture of the train in the middle of the frame counts; one that misses it doesn’t', () => {
    const logic = new PtzLogic(1)
    const c = logic.cams[0]
    const aim = aimAt(c.at, logic.train)
    c.goal = aim
    for (let i = 0; i < 200; i++) stepCam(c, 1 / 60)
    expect(offCentre(c, logic.train)).toBeLessThan(0.1)
    logic.snap(0)
    expect(logic.drain()[0]).toMatchObject({ kind: 'score' })
    c.pan += 1
    logic.snap(0)
    expect(logic.drain()[0]).toMatchObject({ kind: 'tick', text: 'Missed the train' })
  })

  it('Home puts it back in the middle at its first zoom', () => {
    const logic = new PtzLogic(1)
    const c = logic.cams[0]
    c.goal = [1, 0.3]
    c.zoom = 6
    logic.home(0)
    settle(logic, () => null)
    expect(c.pan).toBeCloseTo(c.home[0], 3)
    expect(c.zoom).toBe(1.4)
    expect(logic.readout(0)).toBe('1.4× · 0 shots')
  })
})
