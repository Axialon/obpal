import { describe, expect, it } from 'vitest'
import { classical, restIntent } from '../src/sim/humanoid/controls'
import { restInput } from '../src/sim/devices/types'
import { INTENT_DEFAULTS, mapIntent, walkingIntent, type Intent } from '../src/sim/humanoid/physics/intent'
import { emptyPad } from '@obpal/core'
import { rotate, fromRotationVector, type Vec3 } from '../src/sim/physics/math'

const origin = { x: 0, z: 0 }
const intent = (overrides: Partial<Intent> = {}): Intent => ({ ...restIntent(), ...overrides })
function vector(actual: Vec3, expected: Vec3) {
  for (const axis of ['x', 'y', 'z'] as const) expect(actual[axis]).toBeCloseTo(expected[axis], 10)
}

describe('humanoid desired motion from phone intent', () => {
  it.each([[-1, -.5], [1, .25]])('maps left-stick Y %s to forward/back velocity %s m/s', (y, speed) => {
    const input = restInput(); input.pad = emptyPad(); input.pad.axes[1] = y
    const desired = mapIntent(walkingIntent(input), 0, origin)
    vector(desired.velocity, { x: 0, y: 0, z: speed }); expect(desired.yawRateRadps).toBe(0)
  })
  it.each([-1, 1])('maps left-stick X %s to turn without sideways motion', x => {
    const input = restInput(); input.pad = emptyPad(); input.pad.axes[0] = x
    const walk = walkingIntent(input), desired = mapIntent(walk, 0, origin)
    expect(walk.manual).toBe(true); expect(desired.yawRateRadps).toBe(x)
    vector(desired.velocity, { x: 0, y: 0, z: 0 })
  })
  it('rests when watchdog quiet is set even if the last stick sample remains held', () => {
    const input = restInput(); input.pad = emptyPad(); input.pad.axes = [1, -1, 1, 0]; input.quiet = true
    expect(walkingIntent(input)).toEqual(restIntent())
    expect(walkingIntent(undefined)).toEqual(restIntent())
  })
  it.each([
    [{ z: -1 }, { x: 0, y: 0, z: -.5 }],
    [{ z: 1 }, { x: 0, y: 0, z: .25 }],
    [{ x: 1 }, { x: .25, y: 0, z: 0 }],
    [{ x: -1 }, { x: -.25, y: 0, z: 0 }],
  ])('maps %j to the specified m/s limits', (axes, expected) => {
    vector(mapIntent(intent(axes), 0, origin).velocity, expected)
  })
  it('preserves the classical phone convention: negative Z points toward the toes', () => {
    const input = restInput(); input.tilt = [0, -1]
    vector(mapIntent(classical(input), 0, origin).velocity, { x: 0, y: 0, z: -.5 })
  })
  it.each([Math.PI / 2, -Math.PI / 2, Math.PI, .37])('rotates desired velocity into heading %s', heading => {
    vector(mapIntent(intent({ z: -1 }), heading, origin).velocity,
      rotate(fromRotationVector({ x: 0, y: heading, z: 0 }), { x: 0, y: 0, z: -.5 }))
  })
  it('keeps partial input proportional above the radial translation deadzone', () => {
    vector(mapIntent(intent({ x: .4, z: -.6 }), 0, origin).velocity, { x: .1, y: 0, z: -.3 })
    vector(mapIntent(intent({ x: .03, z: -.03 }), 0, origin).velocity, { x: 0, y: 0, z: 0 })
    vector(mapIntent(intent({ x: .04, z: -.04 }), 0, origin).velocity, { x: .01, y: 0, z: -.02 })
  })
  it('deadbands translation and yaw independently, including the exact boundary', () => {
    const below = mapIntent(intent({ x: .05, yaw: -.05 }), 0, origin)
    vector(below.velocity, { x: 0, y: 0, z: 0 }); expect(below.yawRateRadps).toBe(0)
    expect(mapIntent(intent({ x: 1, yaw: .04 }), 0, origin).yawRateRadps).toBe(0)
    const turn = mapIntent(intent({ x: .04, yaw: 1 }), 0, origin)
    vector(turn.velocity, { x: 0, y: 0, z: 0 }); expect(turn.yawRateRadps).toBe(1)
  })
  it('limits diagonal input to radius one before applying directional speeds', () => {
    const diagonal = mapIntent(intent({ x: 1, z: -1 }), 0, origin)
    vector(diagonal.velocity, { x: .25 / Math.SQRT2, y: 0, z: -.5 / Math.SQRT2 })
    expect(Math.hypot(diagonal.velocity.x, diagonal.velocity.z)).toBeLessThanOrEqual(INTENT_DEFAULTS.forwardMps)
    vector(mapIntent(intent({ x: 100, z: -100 }), 0, origin).velocity, diagonal.velocity)
  })
  it('maps yaw to at most 1 rad/s, with no translation or heading-state mutation', () => {
    for (const yaw of [-10, -.6, .6, 10]) {
      const desired = mapIntent(intent({ yaw }), 1.2, origin)
      expect(desired.yawRateRadps).toBe(Math.max(-1, Math.min(1, yaw)))
      vector(desired.velocity, { x: 0, y: 0, z: 0 })
    }
  })
  it('tapers outward motion to zero at each wall and leaves inward motion available', () => {
    for (const axis of ['x', 'z'] as const) for (const side of [-1, 1]) {
      const outward = intent({ [axis]: side }), inward = intent({ [axis]: -side })
      const free = mapIntent(outward, 0, origin).velocity[axis]
      const near = { ...origin, [axis]: side * (INTENT_DEFAULTS.wallM - INTENT_DEFAULTS.wallTaperM / 2) }
      expect(mapIntent(outward, 0, near).velocity[axis]).toBeCloseTo(free / 2, 10)
      expect(mapIntent(inward, 0, near).velocity[axis]).toBe(mapIntent(inward, 0, origin).velocity[axis])
      for (const outside of [INTENT_DEFAULTS.wallM, INTENT_DEFAULTS.wallM + 1]) {
        const position = { ...origin, [axis]: side * outside }
        expect(Math.abs(mapIntent(outward, 0, position).velocity[axis])).toBe(0)
        expect(mapIntent(inward, 0, position).velocity[axis]).toBe(mapIntent(inward, 0, origin).velocity[axis])
      }
    }
  })
  it('applies walls in world coordinates after heading and preserves motion along the wall', () => {
    const atWall = mapIntent(intent({ z: -1, yaw: .6 }), -Math.PI / 2, { x: 3.3, z: 0 })
    expect(atWall.velocity.x).toBe(0); expect(atWall.yawRateRadps).toBe(.6)
    vector(mapIntent(intent({ z: -1 }), 0, { x: 3.3, z: 0 }).velocity, { x: 0, y: 0, z: -.5 })
  })
  it('rests on input loss and preserves upper-body presets during ordinary rest', () => {
    vector(mapIntent(undefined, .2, origin).velocity, { x: 0, y: 0, z: 0 })
    expect(mapIntent(undefined, .2, origin).yawRateRadps).toBe(0)
    const resting = mapIntent(intent({ preset: 'guard' }), .2, origin)
    vector(resting.velocity, { x: 0, y: 0, z: 0 }); expect(resting.preset).toBe('guard')
  })
  it('stand cancels both movement and presets while retaining the supervisor command', () => {
    const standing = mapIntent(intent({ x: 1, z: -1, yaw: 1, preset: 'jab', command: 'stand' }), 0, origin)
    vector(standing.velocity, { x: 0, y: 0, z: 0 })
    expect(standing.yawRateRadps).toBe(0); expect(standing.preset).toBeUndefined(); expect(standing.command).toBe('stand')
  })
  it.each(['push', 'getup'] as const)('passes %s to the supervisor without inventing movement', command => {
    const desired = mapIntent(intent({ command }), 0, origin)
    expect(desired.command).toBe(command); vector(desired.velocity, { x: 0, y: 0, z: 0 })
  })
  it('rejects nonfinite input or frame data and leaves caller-owned values unchanged', () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      for (const axis of ['x', 'z', 'yaw'] as const) expect(() => mapIntent(intent({ [axis]: invalid }), 0, origin)).toThrow('Invalid intent axes')
      expect(() => mapIntent(intent(), invalid, origin)).toThrow('Invalid intent heading or position')
      expect(() => mapIntent(intent(), 0, { x: invalid, z: 0 })).toThrow('Invalid intent heading or position')
      expect(() => mapIntent(intent(), 0, { x: 0, z: invalid })).toThrow('Invalid intent heading or position')
    }
    const input = Object.freeze(intent({ x: .5, z: -.7, yaw: .3 })), position = Object.freeze({ x: 3.2, z: -.1 })
    const before = structuredClone({ input, position })
    mapIntent(input, .7, position)
    expect({ input, position }).toEqual(before)
  })
})
