import { describe, expect, it } from 'vitest'
import { BODY_BYTES, BODY_HEADER, decodeBody, encodeBody, decodeHand, decodePose, decodeState, packetType } from '@obpal/core'
import { bodyState } from './body-fixture'

describe('BODY framing', () => {
  it('fills exactly 276 little-endian bytes without changing any existing decoder', () => {
    const s = bodyState(), bytes = encodeBody(s), view = new DataView(bytes)
    expect(bytes.byteLength).toBe(BODY_BYTES)
    expect(packetType(bytes)).toBe(BODY_HEADER)
    expect([...new Uint8Array(bytes).slice(0, 12)]).toEqual([0x17, 1, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 9, 33, 0, 0])
    for (let i = 0; i < 33; i++) {
      for (let a = 0; a < 3; a++) expect(view.getInt16(12 + 8 * i + a * 2, true)).toBe(Math.round(s.landmarks[i][a] * 2000) || 0)
      expect(view.getUint8(18 + 8 * i)).toBe(204)
      expect(view.getUint8(19 + 8 * i)).toBe(230)
    }
    expect(decodeHand(bytes)).toBeNull(); expect(decodePose(bytes)).toBeNull(); expect(decodeState(bytes)).toBeNull()
  })
  it('bounds position error to 0.25 mm and confidence error to half an unorm8 step', () => {
    const s = bodyState(); s.landmarks[0] = [-16.384, 16.3835, .00025]
    const out = new ArrayBuffer(BODY_BYTES)
    expect(encodeBody(s, out)).toBe(out)
    const back = decodeBody(out)!
    s.landmarks.forEach((p, i) => p.forEach((n, a) => expect(Math.abs(back.landmarks[i][a] - n)).toBeLessThanOrEqual(.00025 + 1e-12)))
    s.presence.forEach((p, i) => expect(Math.abs(back.presence[i] - p)).toBeLessThanOrEqual(.5 / 255 + 1e-12))
  })
  it.each([{ seq: 0, t: 0, gen: 0 }, { seq: 65535, t: 0xffffffff, gen: 255 }])('round trips counter limits %j', counters => {
    expect(decodeBody(encodeBody(bodyState(counters)))).toMatchObject(counters)
  })
  it.each([0, 1, 9, 10, 11])('rejects invalid header byte %i', index => {
    const packet = encodeBody(bodyState()); new Uint8Array(packet)[index] = 255
    expect(decodeBody(packet)).toBeNull()
  })
  it.each([0, 12, 275, 277, 1000])('rejects %i bytes', size => expect(decodeBody(new ArrayBuffer(size))).toBeNull())
  it.each([{ flags: 2 }, { flags: -.1 }, { seq: -1 }, { seq: 65536 }, { seq: NaN }, { t: Infinity }, { gen: 256 }])('rejects invalid counters %j', extra => {
    expect(() => encodeBody(bodyState(extra))).toThrow()
  })
  it.each(['landmarks', 'visibility', 'presence'] as const)('rejects short or sparse %s', field => {
    const s = bodyState(); s[field].pop(); expect(() => encodeBody(s)).toThrow()
    const sparse = bodyState(); delete sparse[field][5]; expect(() => encodeBody(sparse)).toThrow()
  })
  it.each([NaN, Infinity, -16.385, 16.384])('rejects a bad coordinate %s', n => {
    const s = bodyState(); s.landmarks[32][2] = n; expect(() => encodeBody(s)).toThrow()
  })
  it.each([NaN, -.1, 1.1])('rejects confidence %s', n => {
    const s = bodyState(); s.presence[0] = n; expect(() => encodeBody(s)).toThrow()
  })
})
