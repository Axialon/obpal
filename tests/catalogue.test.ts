import { describe, expect, it } from 'vitest'
import {
  addStick, decodePointer, encodePointer, emptyPointer, flyVector, isProfileId, jumpDeadzone, mixStick, offeredMotion, packetType,
  POINTER_HEADER, PointerFlag, pointerDelta, PROFILES, rateToUnit, resolveProfile, REST, shapeVector, wheelVector,
} from '@obpal/core'
import { activeProfile, composeSticks, profileKey, type MotionInputs } from '../src/controller/gamepad'

const mag = (v: readonly [number, number]) => Math.hypot(v[0], v[1])
const none: MotionInputs = { rates: null, tilt: null }

describe('POINTER packet', () => {
  it('round-trips angles, flags and the generation at 0.01°', () => {
    const p = emptyPointer()
    p.seq = 65535
    p.t = 0xfffffff0
    p.flags = PointerFlag.valid | PointerFlag.edgeTurn
    p.yaw = -12.346
    p.pitch = 33.33
    p.gen = 255
    const buf = encodePointer(p)
    expect(buf.byteLength).toBe(16)
    expect(packetType(buf)).toBe(POINTER_HEADER)
    const d = decodePointer(buf)!
    expect(d).toMatchObject({ seq: 65535, t: 0xfffffff0, flags: p.flags, gen: 255 })
    expect(d.yaw).toBeCloseTo(-12.35, 5)
    expect(d.pitch).toBeCloseTo(33.33, 5)
    expect(decodePointer(new ArrayBuffer(16))).toBeNull()
    expect(decodePointer(new ArrayBuffer(8))).toBeNull()
  })

  it('differences relative accumulators across the wrap and never across a recentre', () => {
    const a = emptyPointer()
    const b = emptyPointer()
    a.yaw = 327
    b.yaw = 327 + 3 // wraps int16 on the wire
    const da = decodePointer(encodePointer(a))!
    const db = decodePointer(encodePointer(b))!
    expect(pointerDelta(db, da)[0]).toBeCloseTo(3, 2)
    expect(pointerDelta(da, db)[0]).toBeCloseTo(-3, 2)
    db.gen = 1
    expect(pointerDelta(db, da)).toEqual([0, 0])
  })
})

describe('response maths (CATALOGUE §2)', () => {
  it('turn rates map to a unit vector, full at 180°/s, turning left is stick left and up is stick up', () => {
    expect(rateToUnit(180, 0)).toEqual([-1, -0])
    expect(rateToUnit(-90, 0)[0]).toBeCloseTo(0.5, 6)
    expect(rateToUnit(0, 90)[1]).toBeCloseTo(-0.5, 6)
    expect(rateToUnit(-720, 720)).toEqual([1, -1])
  })

  it('gain and curve act on the magnitude and keep the direction; invertY flips y', () => {
    expect(shapeVector([0.3, 0.4], { gain: 1, curve: 1, invertY: false })).toEqual([0.3, 0.4])
    const curved = shapeVector([0.3, 0.4], { gain: 1, curve: 2, invertY: false })
    expect(mag(curved)).toBeCloseTo(0.25, 6)
    expect(curved[0] / curved[1]).toBeCloseTo(0.75, 6)
    expect(mag(shapeVector([0.3, 0.4], { gain: 2, curve: 1, invertY: false }))).toBeCloseTo(1, 6) // clamped
    expect(shapeVector([0.3, 0.4], { gain: 1, curve: 1, invertY: true })).toEqual([0.3, -0.4])
    expect(shapeVector([0, 0], { gain: 3, curve: 2, invertY: true })).toEqual([0, 0])
  })

  it('the deadzone jump lands any deliberate motion past the game deadzone, direction kept, still phone at rest', () => {
    const small = jumpDeadzone([0.11, 0], 0.2)
    expect(small[0]).toBeCloseTo(0.2 + 0.8 * 0.11, 6)
    expect(small[1]).toBe(0)
    const diag = jumpDeadzone([0.1, 0.1], 0.2)
    expect(diag[0]).toBeCloseTo(diag[1], 9) // a diagonal stays a diagonal
    expect(mag(diag)).toBeCloseTo(0.2 + 0.8 * Math.hypot(0.1, 0.1), 6)
    expect(jumpDeadzone([REST * 0.5, 0], 0.2)).toEqual([0, 0])
    expect(mag(jumpDeadzone([3, 4], 0.2))).toBeCloseTo(1, 6)
    expect(jumpDeadzone([-0.5, 0], 0)).toEqual([-0.5, 0])
  })

  it('a small aim motion clears an 0.18 deadzone (CVC Collider) where the plain rate would not', () => {
    const rate = rateToUnit(20, 0) // 20°/s: a typical deliberate correction
    expect(Math.abs(rate[0])).toBeLessThan(0.18)
    expect(Math.abs(jumpDeadzone(rate, 0.2)[0])).toBeGreaterThan(0.18)
  })

  it('mixes the thumb with motion and jumps once, with the largest deadzone asked for', () => {
    expect(mixStick([0.13, 0], [])).toEqual([0.13, 0]) // the thumb alone is untouched
    expect(mixStick([0.13, 0], [{ v: [0, 0], deadzone: 0.2 }])).toEqual([0.13, 0])
    const m = mixStick([0.1, 0], [{ v: [0.1, 0], deadzone: 0.2 }, { v: [0.1, 0], deadzone: 0.3 }])
    expect(m[0]).toBeCloseTo(0.3 + 0.7 * 0.3, 6)
    expect(mag(mixStick([0.9, 0], [{ v: [0.9, 0.5], deadzone: 0.2 }]))).toBeCloseTo(1, 6)
    expect(addStick([0.2, 0], [0.3, 0])).toEqual([0.5, 0])
  })

  it('fly and wheel read the tilt stick: tilt is X, pulling back is nose up, the wheel has no Y', () => {
    expect(flyVector([0.4, 0.3])).toEqual([0.4, -0.3])
    expect(wheelVector([0.4, 0.3])).toEqual([0.4, 0])
  })
})

describe('profiles (CATALOGUE §3)', () => {
  it('ships the five built-ins with the routes the spec names', () => {
    expect(Object.keys(PROFILES)).toEqual(['default', 'flight', 'driving', 'shooter', 'pointer'])
    expect(PROFILES.default).toMatchObject({ aim: { route: 'stick.right', deadzone: 0.2 }, steer: { route: 'stick.wheel' }, point: { route: 'pointer' } })
    expect(PROFILES.flight).toMatchObject({ aim: { route: 'stick.right', deadzone: 0.2 }, steer: { route: 'stick.fly', deadzone: 0.2 } })
    expect(PROFILES.driving.steer.route).toBe('stick.wheel')
    expect(PROFILES.shooter.aim.route).toBe('mouse')
    expect(PROFILES.shooter.point.edgeTurn).toBe(true)
    expect(PROFILES.pointer.on).toEqual(['motion.point'])
    expect(isProfileId('flight')).toBe(true)
    expect(isProfileId('racing')).toBe(false)
  })

  it('applies user overrides within bounds and ignores routes a utility cannot take', () => {
    const p = resolveProfile('flight', { aim: { gain: 9, invertY: true, route: 'pointer' as never }, steer: { route: 'stick.left', deadzone: -1 } })
    expect(p.aim).toMatchObject({ gain: 4, invertY: true, route: 'stick.right' })
    expect(p.steer).toMatchObject({ route: 'stick.left', deadzone: 0 })
    expect(resolveProfile('flight').steer.route).toBe('stick.fly')
  })

  it('the layout limits which motion utilities are offered', () => {
    expect(offeredMotion(undefined)).toEqual(['motion.aim', 'motion.steer', 'motion.point'])
    expect(offeredMotion(['pad', 'motion.point'])).toEqual(['motion.point'])
    expect(offeredMotion(['pad'])).toEqual([])
  })

  it('the phone applies a host suggestion unless the user chose, remembered per host and suggestion', () => {
    expect(activeProfile(null, undefined)).toBe('default')
    expect(activeProfile(null, 'flight')).toBe('flight')
    expect(activeProfile('shooter', 'flight')).toBe('shooter')
    expect(activeProfile('bogus', 'bogus')).toBe('default')
    expect(profileKey('ob.Pal Link', 'flight')).not.toBe(profileKey('ob.Pal Link', null))
  })
})

describe('routes on the phone (composeSticks)', () => {
  it('Aim on the right stick clears the deadzone with a small turn; the thumb still works alone', () => {
    const { axes, mouse } = composeSticks([0, 0], [0, 0], { rates: [20, 0], tilt: null }, PROFILES.default)
    expect(axes[2]).toBeLessThan(-0.18) // turning left
    expect(axes[3]).toBe(0)
    expect(axes[0]).toBe(0)
    expect(mouse).toBeNull()
    expect(composeSticks([0.3, 0.1], [0.2, 0.2], none, PROFILES.default).axes).toEqual([0.3, 0.1, 0.2, 0.2])
  })

  it('Steer: the wheel is the left stick X only; fly is the right stick, both axes, nose up when pulling back', () => {
    const wheel = composeSticks([0, 0], [0, 0], { rates: null, tilt: [0.5, 0.5] }, PROFILES.default).axes
    expect(wheel[0]).toBeGreaterThan(0.5)
    expect(wheel[1]).toBe(0)
    expect(wheel[2]).toBe(0)
    expect(wheel[3]).toBe(0)
    const fly = composeSticks([0, 0], [0, 0], { rates: null, tilt: [0.5, 0.5] }, PROFILES.flight).axes
    expect(fly[0]).toBe(0)
    expect(fly[1]).toBe(0)
    expect(fly[2]).toBeGreaterThan(0.3)
    expect(fly[3]).toBeLessThan(-0.3)
    const inv = composeSticks([0, 0], [0, 0], { rates: null, tilt: [0, 0.5] }, resolveProfile('flight', { steer: { invertY: true } })).axes
    expect(inv[3]).toBeGreaterThan(0.3)
  })

  it('flight: Aim adds fine correction on top of the yoke, one jump for the stick', () => {
    const both = composeSticks([0, 0], [0, 0], { rates: [-20, 0], tilt: [0.2, 0] }, PROFILES.flight).axes
    const fly = composeSticks([0, 0], [0, 0], { rates: null, tilt: [0.2, 0] }, PROFILES.flight).axes
    expect(both[2]).toBeGreaterThan(fly[2])
    expect(both[2]).toBeCloseTo(0.2 + 0.8 * (0.2 + 20 / 180), 6)
  })

  it('shooter: Aim goes to the mouse as turn rates (+ right, + up) and leaves the sticks alone', () => {
    const { axes, mouse } = composeSticks([0, 0], [0, 0], { rates: [30, 10], tilt: null }, PROFILES.shooter, 2)
    expect(axes).toEqual([0, 0, 0, 0])
    expect(mouse).toEqual([-60, 20])
  })

  it('the global sensitivity and the utility gain multiply', () => {
    const p = resolveProfile('default', { aim: { gain: 2 } })
    const a = composeSticks([0, 0], [0, 0], { rates: [-9, 0], tilt: null }, p, 2).axes[2]
    expect(a).toBeCloseTo(0.2 + 0.8 * ((9 / 180) * 4), 6)
  })
})
