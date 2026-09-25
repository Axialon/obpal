import { describe, expect, it } from 'vitest'
import {
  accumDelta, bindMac, decodeState, emptyState, encodePairing, encodeState, parsePairing, qAxisAngle, qIdentity,
  qRotate, qScale, quatFromDeviceOrientation, relativeInView, roomIdFor, seqNewer, viewFrameAt, type Quat, type Vec3,
} from '@obpal/core'

const close = (a: Vec3, b: Vec3, eps = 1e-3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)))
const D = Math.PI / 180

describe('orientation mapping (hold-the-object metaphor)', () => {
  const flatNorth = quatFromDeviceOrientation(0, 0, 0) // flat, screen up, top pointing north

  it('device axes map to Earth for a flat phone', () => {
    close(qRotate(flatNorth, [0, 1, 0]), [0, 1, 0])
    close(qRotate(flatNorth, [0, 0, 1]), [0, 0, 1])
  })

  it('turning the phone left (about gravity) spins the object about view +y', () => {
    const R = viewFrameAt(flatNorth)
    const rel = relativeInView(flatNorth, qAxisAngle(0, 0, 1, 30 * D), R)
    close(qRotate(rel, [1, 0, 0]), [Math.cos(30 * D), 0, -Math.sin(30 * D)])
  })

  it('tilting the top edge up raises the far side of the object', () => {
    const R = viewFrameAt(flatNorth)
    const rel = relativeInView(flatNorth, qAxisAngle(1, 0, 0, 20 * D), R)
    // far side is view -z; it should gain +y
    expect(qRotate(rel, [0, 0, -1])[1]).toBeGreaterThan(0.3)
  })

  it('an upright phone facing the user yields the same forward direction', () => {
    const upright = quatFromDeviceOrientation(0, 90, 0) // screen toward the user, top up
    const R = viewFrameAt(upright)
    close(qRotate(R, [0, 0, -1]), [0, 1, 0]) // view forward = north, toward the screen
    const rel = relativeInView(upright, qMulWorldYaw(upright, 30), R)
    close(qRotate(rel, [1, 0, 0]), [Math.cos(30 * D), 0, -Math.sin(30 * D)])
  })

  it('screen orientation compensation rotates the frame about z', () => {
    const q = quatFromDeviceOrientation(0, 0, 0, 90)
    close(qRotate(q, [1, 0, 0]), [0, -1, 0])
  })

  it('qScale amplifies the rotation angle', () => {
    const q = qScale(qAxisAngle(0, 1, 0, 10 * D), 2)
    close(qRotate(q, [1, 0, 0]), [Math.cos(20 * D), 0, -Math.sin(20 * D)])
  })
})

function qMulWorldYaw(q: Quat, deg: number): Quat {
  const r = qAxisAngle(0, 0, 1, deg * D)
  const [ax, ay, az, aw] = r
  const [bx, by, bz, bw] = q
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}

describe('STATE codec', () => {
  it('round-trips within quantization', () => {
    const s = emptyState()
    s.seq = 65535
    s.t = 0xfffffff0
    s.flags = 0b10110
    s.qRel = qAxisAngle(0, 1, 0, 1)
    s.aim = [12.345, -6.5]
    s.pad1 = [100.25, -3]
    s.zoom = 0.75
    s.twist = -45.5
    s.buttons = 0x80000001
    const d = decodeState(encodeState(s))!
    expect(d.seq).toBe(65535)
    expect(d.t).toBe(0xfffffff0)
    expect(d.flags).toBe(0b10110)
    expect(d.aim[0]).toBeCloseTo(12.345, 3)
    expect(d.pad1[0]).toBeCloseTo(100.25, 3)
    expect(d.zoom).toBeCloseTo(0.75, 3)
    expect(d.twist).toBeCloseTo(-45.5, 2)
    expect(d.buttons >>> 0).toBe(0x80000001)
    close(qRotate(d.qRel, [1, 0, 0]), qRotate(s.qRel, [1, 0, 0]))
  })

  it('accumulator deltas survive wrap-around', () => {
    const a = emptyState(); a.twist = 327.5; a.zoom = 7.9
    const b = emptyState(); b.twist = 327.5 + 10; b.zoom = 7.9 + 0.5 // both wrap int16
    const d = accumDelta(decodeState(encodeState(b))!, decodeState(encodeState(a))!)
    expect(d.twist).toBeCloseTo(10, 1)
    expect(d.zoom).toBeCloseTo(0.5, 2)
  })

  it('sequence comparison handles wrap and equality', () => {
    expect(seqNewer(1, 65535)).toBe(true)
    expect(seqNewer(65535, 1)).toBe(false)
    expect(seqNewer(5, 5)).toBe(false)
  })

  it('rejects foreign packets', () => {
    expect(decodeState(new ArrayBuffer(10))).toBeNull()
    expect(decodeState(new Uint8Array(76).fill(0x22).buffer)).toBeNull()
  })
})

describe('pairing', () => {
  it('encodes and parses the QR fragment', () => {
    const p = { secret: new Uint8Array(16).fill(7), fp: new Uint8Array(32).fill(9) }
    const back = parsePairing('#' + encodePairing(p))!
    expect([...back.secret]).toEqual([...p.secret])
    expect([...back.fp]).toEqual([...p.fp])
    expect(parsePairing('#2.x.y')).toBeNull()
    expect(parsePairing('garbage')).toBeNull()
  })

  it('binding MAC depends on every input', async () => {
    const s = new Uint8Array(16).fill(1)
    const room = await roomIdFor(s)
    expect(room).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const a = new Uint8Array(32).fill(2)
    const b = new Uint8Array(32).fill(3)
    const m1 = await bindMac(s, a, b, room)
    expect(await bindMac(s, a, b, room)).toBe(m1)
    expect(await bindMac(s, b, a, room)).not.toBe(m1)
    expect(await bindMac(new Uint8Array(16).fill(4), a, b, room)).not.toBe(m1)
  })

  it('identity stays identity', () => {
    close(qRotate(qIdentity(), [1, 2, 3]), [1, 2, 3])
  })
})

describe('1:1 match forward direction in landscape', () => {
  it('a phone held sideways and upright still faces the screen', () => {
    // upright facing the user, then rotated 90 degrees in the screen plane (landscape)
    const q = quatFromDeviceOrientation(0, 90, 0)
    const landscape = qMulLocalZ(q, 90)
    const R = viewFrameAt(landscape)
    close(qRotate(R, [0, 0, -1]), [0, 1, 0])
  })
})

function qMulLocalZ(q: Quat, deg: number): Quat {
  const [ax, ay, az, aw] = q
  const [bx, by, bz, bw] = qAxisAngle(0, 0, 1, deg * D)
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}

describe('PAD packet (standard gamepad)', () => {
  it('round-trips buttons, sticks and triggers', async () => {
    const { encodePad, decodePad, emptyPad, PadButton, packetType, PAD_HEADER } = await import('@obpal/core')
    const p = emptyPad()
    p.seq = 7
    p.buttons = (1 << PadButton.A) | (1 << PadButton.Guide)
    p.axes = [0.5, -1, 0.25, 1]
    p.triggers = [0.2, 1]
    const buf = encodePad(p)
    expect(packetType(buf)).toBe(PAD_HEADER)
    const d = decodePad(buf)!
    expect(d.buttons).toBe(p.buttons)
    d.axes.forEach((v, i) => expect(v).toBeCloseTo(p.axes[i], 3))
    expect(d.triggers[0]).toBeCloseTo(0.2, 2)
    expect(decodePad(new ArrayBuffer(24))).toBeNull()
  })
})
