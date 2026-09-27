import { describe, expect, it } from 'vitest'
import { Mode, PadButton, qIdentity } from '@obpal/core'
import { DRONE, DroneLogic, PYLONS, RINGS, throughRing } from '../src/sim/devices/drone'
import { restInput, type DeviceInput } from '../src/sim/devices/types'

const pad = (axes: [number, number, number, number], triggers: [number, number] = [0, 0], buttons = 0) => ({ flags: 0, seq: 0, t: 0, buttons, axes, triggers })
const at = (over: Partial<DeviceInput>): DeviceInput => ({ ...restInput(), ...over })
const run = (logic: DroneLogic, input: (n: number) => DeviceInput | null, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) logic.step(logic.drones.map((_, n) => input(n)), dt)
}
const takeOff = (logic: DroneLogic) => {
  logic.step([at({ pad: pad([0, 0, 0, 0]), padPressed: 1 << PadButton.A })], 1 / 60)
  run(logic, () => at({ pad: pad([0, 0, 0, 0]) }), 3)
}

describe('drone: each controller flies it', () => {
  it('has a larger course whose rings clear the cage and whose pylons stop a drone', () => {
    expect(DRONE.cage[0] * DRONE.cage[1] * DRONE.ceiling).toBeGreaterThan(4 * 4.2 * 3 * 3.2)
    for (const r of RINGS) {
      expect(Math.abs(r.x) + r.r).toBeLessThan(DRONE.cage[0])
      expect(r.y + r.r).toBeLessThan(DRONE.ceiling)
    }
    const logic = new DroneLogic(1), d = logic.drones[0], p = PYLONS[0]
    Object.assign(d, { x: p.x, z: p.z + 0.4, y: 1, phase: 'flying', vz: -1 })
    logic.step([null], 1 / 60)
    expect(Math.hypot(d.x - p.x, d.z - p.z)).toBeGreaterThanOrEqual(p.radius + DRONE.radius - 1e-6)
    Object.assign(d, { x: p.x, z: p.z, y: p.height + DRONE.radius + 0.1, vy: 0, vz: 0 })
    logic.step([null], 1 / 60)
    expect(d.x).toBe(p.x)
    expect(d.z).toBe(p.z)
  })
  it('gamepad, Mode 2: A takes off to a hover and lands again; the left stick climbs, the right stick flies', () => {
    const logic = new DroneLogic(1)
    const d = logic.drones[0]
    takeOff(logic)
    expect(d.phase).toBe('flying')
    expect(d.y).toBeGreaterThan(DRONE.hover - 0.1)
    const y0 = d.y
    run(logic, () => at({ pad: pad([0, -1, 0, 0]) }), 0.8)
    expect(d.y).toBeGreaterThan(y0 + 0.5)
    const z0 = d.z
    run(logic, () => at({ pad: pad([0, 0, 0, -1]) }), 1)
    expect(d.z).toBeLessThan(z0 - 1)
    logic.step([at({ pad: pad([0, 0, 0, 0]), padPressed: 1 << PadButton.A })], 1 / 60)
    run(logic, () => at({ pad: pad([0, 0, 0, 0]) }), 6)
    expect(d.phase).toBe('landed')
    expect(d.y).toBe(0)
  })

  it('holds its height when nothing climbs, and turns with the left stick', () => {
    const logic = new DroneLogic(1)
    const d = logic.drones[0]
    takeOff(logic)
    const y0 = d.y
    run(logic, () => at({ pad: pad([1, 0, 0, 0]) }), 1)
    expect(Math.abs(d.y - y0)).toBeLessThan(0.05)
    expect(d.yaw).toBeLessThan(-1)
  })

  it('3D hand: while the thumb is down it follows the hand, three times as far; let go, it hovers', () => {
    const logic = new DroneLogic(1)
    const d = logic.drones[0]
    takeOff(logic)
    const start = { x: d.x, y: d.y }
    const pose = (p: [number, number, number], touching = true) => at({ face: 'face.hand', mode: Mode.track, pose: { p, q: qIdentity(), tracked: true, touching, gen: 1 } })
    logic.step([pose([0, 0, 0])], 1 / 60)
    run(logic, () => pose([0.2, 0.1, 0]), 3)
    expect(d.x - start.x).toBeCloseTo(0.6, 1)
    expect(d.y - start.y).toBeCloseTo(0.3, 1)
    run(logic, () => pose([0.6, 0.4, 0], false), 2)
    expect(d.x - start.x).toBeCloseTo(0.6, 1)
  })

  it('trackpad: tilting flies it (gyro on), a tap takes off', () => {
    const logic = new DroneLogic(1)
    const d = logic.drones[0]
    logic.step([at({ face: 'face.trackpad', mode: Mode.tilt, presses: ['pad'] })], 1 / 60)
    run(logic, () => at({ face: 'face.trackpad', mode: Mode.tilt }), 3)
    expect(d.phase).toBe('flying')
    const x0 = d.x
    run(logic, () => at({ face: 'face.trackpad', mode: Mode.tilt, tilt: [0.8, 0] }), 1)
    expect(d.x).toBeGreaterThan(x0 + 0.8)
    expect(d.roll).toBeGreaterThan(0.05)
  })

  it('the tray and a headset’s press (tray:fly) take off', () => {
    const logic = new DroneLogic(1)
    logic.step([at({ face: 'face.trackpad', mode: Mode.tilt, presses: ['fly'] })], 1 / 60)
    expect(logic.drones[0].phase).toBe('takeoff')
    expect(logic.drain().some((e) => e.text === 'Taking off')).toBe(true)
  })
})

describe('drone: physics within its limits', () => {
  it('never flies faster than its top speeds, and never leaves the cage or goes through the ceiling', () => {
    const logic = new DroneLogic(1)
    const d = logic.drones[0]
    takeOff(logic)
    let top = 0
    for (let t = 0; t < 12; t += 1 / 60) {
      logic.step([at({ pad: pad([0.2, -1, 1, -1]) })], 1 / 60)
      top = Math.max(top, Math.hypot(d.vx, d.vz))
      expect(Math.abs(d.x)).toBeLessThanOrEqual(DRONE.cage[0] - DRONE.radius + 1e-9)
      expect(Math.abs(d.z)).toBeLessThanOrEqual(DRONE.cage[1] - DRONE.radius + 1e-9)
      expect(d.y).toBeLessThanOrEqual(DRONE.ceiling + 1e-9)
      expect(Math.abs(d.pitch)).toBeLessThanOrEqual(DRONE.maxTilt + 1e-9)
    }
    expect(top).toBeLessThanOrEqual(DRONE.vh * Math.SQRT2 + 1e-6)
    expect(logic.drain().some((e) => e.kind === 'bump')).toBe(true)
  })

  it('counts a ring only when it flies through it', () => {
    const r = RINGS[3]
    expect(throughRing(r, [r.x, r.y, r.z + 0.5], [r.x, r.y, r.z - 0.5])).toBe(true)
    expect(throughRing(r, [r.x + 2, r.y, r.z + 0.5], [r.x + 2, r.y, r.z - 0.5])).toBe(false)
    expect(throughRing(r, [r.x, r.y, r.z + 0.5], [r.x, r.y, r.z + 0.2])).toBe(false)
  })

  it('Home flies it back to its pad and lands it; stick input takes over again', () => {
    const logic = new DroneLogic(1)
    const d = logic.drones[0]
    takeOff(logic)
    run(logic, () => at({ pad: pad([0, 0, 0.6, -0.8]) }), 1.5)
    logic.home(0)
    expect(d.phase).toBe('home')
    run(logic, () => at({ pad: pad([0, 0, 0, 0]) }), 12)
    expect(d.phase).toBe('landed')
    expect(Math.hypot(d.x - d.home[0], d.z - d.home[1])).toBeLessThan(0.15)
    takeOff(logic)
    logic.home(0)
    logic.step([at({ pad: pad([0, 0, 0, -1]) })], 1 / 60)
    expect(d.phase).toBe('flying')
  })

  it('a drone nobody holds stays put, and its input going quiet (null) doesn’t fling it', () => {
    const logic = new DroneLogic(2)
    run(logic, () => null, 2)
    expect(logic.drones.every((d) => d.phase === 'landed' && d.y === 0)).toBe(true)
    expect(logic.readout(0)).toBe('Landed')
  })
})
