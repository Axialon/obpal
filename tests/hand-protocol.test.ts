import { describe, expect, it } from 'vitest'
import {
  decodeHand, decodePad, decodePointer, decodePose, decodeState, encodeHand, HAND_BYTES, HAND_HEADER,
  HandFlag, HandGesture, packetType, type HandState, type Vec3,
} from '@obpal/core'

const hand = (): HandState => ({
  flags: HandFlag.tracked, seq: 0x1234, t: 0x12345678, gen: 9, handedness: 'right', confidence: 0.8,
  gestures: HandGesture.pinch | HandGesture.point, p: [0.1, -0.2, -0.5],
  landmarks: Array.from({ length: 21 }, (_, i): Vec3 => [i / 1000, i ? -i / 2000 : 0, (20 - i) / 2000]),
})

describe('the HAND packet', () => {
  it('uses the complete 144-byte little-endian field layout', () => {
    const s = hand(), packet = encodeHand(s), dv = new DataView(packet)
    expect(packet.byteLength).toBe(HAND_BYTES)
    expect(packetType(packet)).toBe(HAND_HEADER)
    expect(Array.from(new Uint8Array(packet).slice(0, 12))).toEqual([0x16, 1, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 9, 2, 204, 5])
    for (const [n, p] of [s.p, ...s.landmarks].entries()) {
      for (let axis = 0; axis < 3; axis++) expect(dv.getInt16(12 + n * 6 + axis * 2, true)).toBe(Math.round(p[axis] * 2000))
    }
    expect(decodeHand(packet)).toEqual(s)
  })

  it.each(['unknown', 'left', 'right'] as const)('round-trips %s handedness and an optional output buffer', (handedness) => {
    const out = new ArrayBuffer(HAND_BYTES)
    expect(encodeHand({ ...hand(), handedness }, out)).toBe(out)
    expect(decodeHand(out)?.handedness).toBe(handedness)
  })

  it('keeps all positions within 0.25 mm and confidence within half an unorm8 step', () => {
    const s = hand()
    s.p = [-16.384, 16.3835, 0.00025]
    s.confidence = 0.731
    s.landmarks = Array.from({ length: 21 }, (_, i): Vec3 => [Math.sin(i) * 0.12731, Math.cos(i) * 0.07845, (i - 10) * 0.004321])
    const back = decodeHand(encodeHand(s))!
    expect(back.p.slice(0, 2)).toEqual(s.p.slice(0, 2))
    for (const [n, p] of [s.p, ...s.landmarks].entries()) {
      const got = [back.p, ...back.landmarks][n]
      for (let axis = 0; axis < 3; axis++) expect(Math.abs(got[axis] - p[axis])).toBeLessThanOrEqual(0.00025 + 1e-12)
    }
    expect(Math.abs(back.confidence - s.confidence)).toBeLessThanOrEqual(0.5 / 255)
  })

  it('preserves both ends of the wrapping counter ranges', () => {
    for (const counters of [{ seq: 0, t: 0, gen: 0 }, { seq: 65535, t: 0xffffffff, gen: 255 }]) {
      expect(decodeHand(encodeHand({ ...hand(), ...counters }))).toMatchObject(counters)
    }
  })

  it.each([
    { flags: 2 }, { flags: -1 }, { flags: 0.5 }, { seq: -1 }, { seq: 65536 }, { seq: NaN }, { seq: 1.5 },
    { t: -1 }, { t: 0x100000000 }, { t: Infinity }, { t: 0.5 }, { gen: -1 }, { gen: 256 }, { gen: 0.5 },
    { handedness: 'both' }, { confidence: -0.01 }, { confidence: 1.01 }, { confidence: NaN }, { confidence: Infinity },
    { gestures: 8 }, { gestures: -1 }, { gestures: 1.5 },
  ])('refuses invalid header fields %j', (bad) => {
    expect(() => encodeHand({ ...hand(), ...bad } as HandState)).toThrow(RangeError)
  })

  it.each([NaN, Infinity, -Infinity, -16.38401, 16.38351])('refuses invalid coordinate %s in either position array', (bad) => {
    expect(() => encodeHand({ ...hand(), p: [0, bad, 0] })).toThrow(RangeError)
    const s = hand(); s.landmarks[20][2] = bad
    expect(() => encodeHand(s)).toThrow(RangeError)
  })

  it('requires exactly 21 complete Vec3 landmarks and validates before writing', () => {
    const s = hand(), out = new ArrayBuffer(HAND_BYTES)
    new Uint8Array(out).fill(0xaa)
    for (const landmarks of [[], s.landmarks.slice(1), [...s.landmarks, [0, 0, 0]], Array(21), [[0, 0], ...s.landmarks.slice(1)]]) {
      expect(() => encodeHand({ ...s, landmarks } as HandState, out)).toThrow(RangeError)
    }
    expect(() => encodeHand({ ...s, p: Array(3) } as HandState, out)).toThrow(RangeError)
    expect(Array.from(new Uint8Array(out))).toEqual(Array(HAND_BYTES).fill(0xaa))
    expect(() => encodeHand(s, new ArrayBuffer(HAND_BYTES - 1))).toThrow(RangeError)
    expect(() => encodeHand(s, new ArrayBuffer(HAND_BYTES + 1))).toThrow(RangeError)
  })

  it.each([0, 1, HAND_BYTES - 1, HAND_BYTES + 1])('rejects a malformed length of %i bytes', (bytes) => {
    const data = new Uint8Array(bytes)
    data.set(new Uint8Array(encodeHand(hand())).slice(0, bytes))
    expect(decodeHand(data.buffer)).toBeNull()
  })

  it.each([[0, 0x15], [1, 2], [1, 0x81], [9, 3], [9, 255], [11, 8], [11, 0xff]])('rejects reserved or invalid byte %i = %i', (offset, value) => {
    const packet = encodeHand(hand())
    new DataView(packet).setUint8(offset, value)
    expect(decodeHand(packet)).toBeNull()
  })

  it('is ignored by every older input decoder', () => {
    const packet = encodeHand(hand())
    for (const decode of [decodeState, decodePad, decodePointer, decodePose]) expect(decode(packet)).toBeNull()
  })
})
