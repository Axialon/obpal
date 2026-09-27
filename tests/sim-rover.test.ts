import { describe, expect, it } from 'vitest'
import { Mode, PadButton } from '@obpal/core'
import { DragStick } from '../src/sim/devices/input'
import { driveTo, ROVER, RoverLogic, roverIntent, stepRover, type Rover } from '../src/sim/devices/rover'
import { restInput, type DeviceInput } from '../src/sim/devices/types'

const pad = (axes: [number, number, number, number], triggers: [number, number] = [0, 0], buttons = 0) => ({ flags: 0, seq: 0, t: 0, buttons, axes, triggers })
const at = (over: Partial<DeviceInput>): DeviceInput => ({ ...restInput(), ...over })
const run = (logic: RoverLogic, input: (n: number) => DeviceInput | null, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) logic.step(logic.rovers.map((_, n) => input(n)), dt)
}

describe('rover: each controller drives it', () => {
  const r = (): Rover => ({ x: 0, z: 0, h: 0, v: 0, steer: 0, lights: false, honk: 0, braking: false, roll: 0, home: [0, 0, 0] })

  it('steering wheel and gamepad: the left stick steers, RT goes, LT brakes, and with no trigger the stick drives', () => {
    const s = new DragStick()
    expect(roverIntent(at({ face: 'face.wheel', pad: pad([0.5, 0, 0, 0], [0, 0.8]) }), r(), s)).toMatchObject({ steer: expect.closeTo(0.457, 2), throttle: 0.8 })
    expect(roverIntent(at({ face: 'face.wheel', pad: pad([0, 0, 0, 0], [0.6, 0]) }), r(), s).throttle).toBeCloseTo(-0.6)
    expect(roverIntent(at({ pad: pad([0, -1, 0, 0]) }), r(), s).throttle).toBe(1)
    expect(roverIntent(at({ pad: pad([0, 0, 0, 0], [0, 0], 1 << PadButton.B) }), r(), s).brake).toBe(true)
  })

  it('trackpad: a thumb dragged from where it lands is a stick, and tilting (gyro on) steers and goes', () => {
    const s = new DragStick()
    const first = roverIntent(at({ face: 'face.trackpad', mode: Mode.tilt, touching: true, drag: [45, -90] }), r(), s)
    expect(first.steer).toBeGreaterThan(0.4)
    expect(first.throttle).toBeGreaterThan(0.8)
    // Held there, it keeps going; lifted, it stops.
    expect(roverIntent(at({ face: 'face.trackpad', mode: Mode.tilt, touching: true }), r(), s).throttle).toBeGreaterThan(0.8)
    expect(roverIntent(at({ face: 'face.trackpad', mode: Mode.tilt }), r(), s).throttle).toBeCloseTo(0)
    const tilted = roverIntent(at({ face: 'face.trackpad', mode: Mode.tilt, tilt: [0.5, -0.5] }), r(), s)
    expect(tilted.steer).toBeCloseTo(0.5)
    expect(tilted.throttle).toBeCloseTo(0.6)
  })

  it('Wii remote: holding B drives to the spot it points at, and it stops there', () => {
    const logic = new RoverLogic(1)
    const rv = logic.rovers[0]
    const spot: [number, number] = [2, -1.5]
    run(logic, () => at({ face: 'face.wii', mode: Mode.point, point: { x: 0, y: 0, yaw: 0, pitch: 0, off: false }, spot, held: new Set(['wii-b']) }), 12)
    expect(Math.hypot(rv.x - spot[0], rv.z - spot[1])).toBeLessThan(0.35)
    // Letting go of B, it stays.
    const x = rv.x
    run(logic, () => at({ face: 'face.wii', mode: Mode.point, point: { x: 0, y: 0, yaw: 0, pitch: 0, off: false }, spot: [-3, 2] }), 2)
    expect(Math.abs(rv.x - x)).toBeLessThan(0.3)
    expect(Math.abs(rv.v)).toBeLessThan(0.05)
  })

  it('turns toward a spot on its left by steering left', () => {
    const i = driveTo(r(), -2, -1)
    expect(i.steer).toBeLessThan(0)
    expect(i.throttle).toBeGreaterThan(0)
  })
})

describe('rover: physics within its limits', () => {
  it('never goes faster than its top speed, forward or back, and the wheels never turn past their stop', () => {
    const rv: Rover = { x: 0, z: 0, h: 0, v: 0, steer: 0, lights: false, honk: 0, braking: false, roll: 0, home: [0, 0, 0] }
    for (let i = 0; i < 600; i++) stepRover(rv, { steer: 1, throttle: 1, brake: false }, 1 / 60)
    expect(rv.v).toBeLessThanOrEqual(ROVER.vmax + 1e-9)
    expect(Math.abs(rv.steer)).toBeLessThanOrEqual(ROVER.steerMax)
    for (let i = 0; i < 600; i++) stepRover(rv, { steer: -1, throttle: -1, brake: false }, 1 / 60)
    expect(rv.v).toBeGreaterThanOrEqual(-ROVER.vrev - 1e-9)
    expect(rv.v).toBeLessThan(0)
  })

  it('throttle sets a speed; let go, it coasts to a stop; the brake stops it sooner', () => {
    const rv: Rover = { x: 0, z: 0, h: 0, v: 0, steer: 0, lights: false, honk: 0, braking: false, roll: 0, home: [0, 0, 0] }
    for (let i = 0; i < 300; i++) stepRover(rv, { steer: 0, throttle: 0.5, brake: false }, 1 / 60)
    expect(rv.v).toBeCloseTo(0.5 * ROVER.vmax, 1)
    const coast = { ...rv }
    let tc = 0
    while (coast.v > 0.01 && tc < 20) { stepRover(coast, { steer: 0, throttle: 0, brake: false }, 1 / 60); tc += 1 / 60 }
    let tb = 0
    while (rv.v > 0.01 && tb < 20) { stepRover(rv, { steer: 0, throttle: 0, brake: true }, 1 / 60); tb += 1 / 60 }
    expect(tc).toBeLessThan(5)
    expect(tb).toBeLessThan(tc / 3)
  })

  it('stays inside the yard whatever it’s told, and a knock on the fence rumbles once', () => {
    const logic = new RoverLogic(1)
    const [X, Z] = ROVER.yard
    run(logic, () => at({ pad: pad([0.3, 0, 0, 0], [0, 1]) }), 20)
    const rv = logic.rovers[0]
    expect(Math.abs(rv.x)).toBeLessThanOrEqual(X - ROVER.radius + 1e-9)
    expect(Math.abs(rv.z)).toBeLessThanOrEqual(Z - ROVER.radius + 1e-9)
    expect(logic.drain().some((e) => e.kind === 'bump')).toBe(true)
  })

  it('two rovers never overlap, and a rover shoves a cone it drives into', () => {
    const logic = new RoverLogic(2)
    const [a, b] = logic.rovers
    Object.assign(a, { x: -1, z: 0, h: -Math.PI / 2 })
    Object.assign(b, { x: 1, z: 0, h: Math.PI / 2 })
    run(logic, () => at({ pad: pad([0, 0, 0, 0], [0, 1]) }), 3)
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(2 * ROVER.radius - 1e-6)
    const cone = logic.cones[2]
    const start = { x: cone.x, z: cone.z }
    Object.assign(a, { x: cone.x, z: cone.z + 1.2, h: 0, v: 0 })
    Object.assign(b, { x: 4, z: 2.5 })
    run(logic, (n) => (n === 0 ? at({ pad: pad([0, 0, 0, 0], [0, 0.6]) }) : null), 1.5)
    expect(Math.hypot(cone.x - start.x, cone.z - start.z)).toBeGreaterThan(0.2)
  })

  it('Home parks it where it started, at rest', () => {
    const logic = new RoverLogic()
    run(logic, () => at({ pad: pad([0.4, 0, 0, 0], [0, 1]) }), 2)
    logic.home(0)
    const rv = logic.rovers[0]
    expect([rv.x, rv.z, rv.h, rv.v]).toEqual([...rv.home, 0])
  })

  it('the horn and the lights answer the tray, a tap, A and X', () => {
    const logic = new RoverLogic(1)
    logic.step([at({ presses: ['horn'] })], 1 / 60)
    expect(logic.rovers[0].honk).toBeGreaterThan(0)
    logic.step([at({ pad: pad([0, 0, 0, 0]), padPressed: 1 << PadButton.X })], 1 / 60)
    expect(logic.rovers[0].lights).toBe(true)
    expect(logic.readout(0)).toMatch(/km\/h$/)
  })
})
