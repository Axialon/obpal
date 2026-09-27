import { beforeAll, describe, expect, it } from 'vitest'
import { decodePad, PadFlag, type Quat, type Vec3 } from '@obpal/core'
import { GamepadMode, TurnWatch } from '../src/controller/gamepad'
import type { Motion } from '../src/controller/motion'

// The gamepad layer listens on the page and marks it; with its controls not mounted, a few stand-ins are enough.
beforeAll(() => {
  const listens = { addEventListener() {}, removeEventListener() {} }
  Object.assign(globalThis, {
    ...listens,
    document: { ...listens, visibilityState: 'visible', documentElement: { classList: { toggle() {} } } },
    screen: { orientation: { angle: 0 } },
  })
})

/** A phone whose motion the test sets: its orientation (null until the sensors start) and which way is up. */
function phone() {
  const motion = { q: null as Quat | null, hasGyro: true, flowing: true, gyro: [0, 0, 0] as Vec3, accel: null, up: (): Vec3 => [0, 0.7, 0.7] }
  const sent: ArrayBuffer[] = []
  const gp = new GamepadMode({
    motion: motion as unknown as Motion, settings: { gain: 1, smooth: 0.5 }, t0: 0,
    send: (b) => { sent.push(b.slice(0)); return true }, toast: () => {}, openSettings: () => {}, exit: () => {},
  })
  /** What the screen sees last: the PAD packet's flags (Steer on is PadFlag.tiltSteer). */
  const flags = () => decodePad(sent[sent.length - 1])?.flags ?? 0
  return { motion, gp, sent, flags }
}

describe('a profile’s utilities switch on as it applies (CATALOGUE §3)', () => {
  it('Driving and Flight switch Steer on at once where the phone has motion; Default doesn’t', () => {
    for (const [profile, steer] of [['driving', true], ['flight', true], ['default', false], ['shooter', false]] as const) {
      const p = phone()
      p.motion.q = [0, 0, 0, 1]
      p.gp.setHost({ name: 'Rover', profile })
      p.gp.sync({ active: true, offered: true })
      p.gp.pump()
      expect((p.flags() & PadFlag.tiltSteer) !== 0, profile).toBe(steer)
    }
  })

  it('before the phone has motion (sensors late, or waiting for Start), Steer comes on with the first sample', () => {
    const p = phone()
    p.gp.setHost({ name: 'Rover', profile: 'driving' })
    p.gp.sync({ active: true, offered: true })
    p.gp.pump()
    expect(p.flags() & PadFlag.tiltSteer).toBe(0)
    p.motion.q = [0, 0, 0, 1]
    p.gp.pump()
    expect(p.flags() & PadFlag.tiltSteer).toBe(PadFlag.tiltSteer)
  })

  it('a host that doesn’t take Steer never gets it switched on', () => {
    const p = phone()
    p.gp.setHost({ name: 'Game', profile: 'flight', utilities: ['pad', 'motion.aim'] })
    p.motion.q = [0, 0, 0, 1]
    p.gp.sync({ active: true, offered: true })
    p.gp.pump()
    expect(p.flags() & PadFlag.tiltSteer).toBe(0)
  })

  it('with Steer on, the level is where the phone is held when it comes on: held still, the stick stays centred', () => {
    const p = phone()
    p.motion.q = [0, 0, 0, 1]
    p.gp.setHost({ name: 'Rover', profile: 'driving' })
    p.gp.sync({ active: true, offered: true })
    p.gp.pump()
    const pad = decodePad(p.sent[p.sent.length - 1])!
    expect(Math.abs(pad.axes[0])).toBeLessThan(1e-3)
  })
})

describe('the screen turning takes the level again', () => {
  it('once the phone has settled in the new frame, and once only', () => {
    const w = new TurnWatch(400)
    expect(w.step(0, 0)).toBe(false)
    expect(w.step(0, 1000)).toBe(false)
    expect(w.step(90, 1100)).toBe(false)
    expect(w.step(90, 1400)).toBe(false)
    expect(w.step(90, 1500)).toBe(true)
    expect(w.step(90, 1600)).toBe(false)
  })

  it('a turn back before it settled waits for the latest one; reset starts afresh', () => {
    const w = new TurnWatch(400)
    w.step(0, 0)
    w.step(90, 100)
    expect(w.step(0, 300)).toBe(false)
    expect(w.step(0, 600)).toBe(false)
    expect(w.step(0, 700)).toBe(true)
    w.reset()
    expect(w.step(270, 800)).toBe(false)
    expect(w.step(270, 5000)).toBe(false)
  })
})
