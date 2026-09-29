/** BODY v1: 33 hip-centred landmarks in camera metres, x right, y up, z toward the camera. */
import type { Vec3 } from './quat'

export const BODY_HEADER = 0x17
export const BODY_BYTES = 276
export const BODY_POINTS = 33
export const BodyFlag = { tracked: 1 } as const

export interface BodyState {
  flags: number
  seq: number
  /** Capture microseconds on the device session clock (u32, wraps). */
  t: number
  /** New tracking identity/origin (u8, wraps); sequence continues. */
  gen: number
  landmarks: Vec3[]
  visibility: number[]
  /** Effective presence; producers without a presence score use visibility, gated by image bounds. */
  presence: number[]
}

const uint = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max
const score = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1

/** Reject invalid fields instead of silently wrapping coordinates or trusting partial arrays. */
export function encodeBody(s: BodyState, out = new ArrayBuffer(BODY_BYTES)): ArrayBuffer {
  if (out.byteLength !== BODY_BYTES) throw new RangeError('BODY output must be 276 bytes')
  if (!uint(s.flags, BodyFlag.tracked) || !uint(s.seq, 65535) || !uint(s.t, 0xffffffff) || !uint(s.gen, 255)
    || ![s.landmarks, s.visibility, s.presence].every(a => Array.isArray(a) && a.length === BODY_POINTS)) throw new RangeError('Invalid BODY fields')
  for (let i = 0; i < BODY_POINTS; i++) {
    const p = s.landmarks[i]
    if (!Array.isArray(p) || p.length !== 3 || !Array.from(p).every(n => Number.isFinite(n) && n >= -16.384 && n <= 16.3835)
      || !score(s.visibility[i]) || !score(s.presence[i])) throw new RangeError('Invalid BODY landmark')
  }
  const dv = new DataView(out)
  dv.setUint8(0, BODY_HEADER); dv.setUint8(1, s.flags)
  dv.setUint16(2, s.seq, true); dv.setUint32(4, s.t, true); dv.setUint8(8, s.gen)
  dv.setUint8(9, BODY_POINTS); dv.setUint16(10, 0, true)
  for (let i = 0; i < BODY_POINTS; i++) {
    for (let a = 0; a < 3; a++) dv.setInt16(12 + i * 8 + a * 2, Math.round(s.landmarks[i][a] * 2000), true)
    dv.setUint8(18 + i * 8, Math.round(s.visibility[i] * 255))
    dv.setUint8(19 + i * 8, Math.round(s.presence[i] * 255))
  }
  return out
}

export function decodeBody(buf: ArrayBuffer): BodyState | null {
  if (buf.byteLength !== BODY_BYTES) return null
  const dv = new DataView(buf)
  if (dv.getUint8(0) !== BODY_HEADER || (dv.getUint8(1) & ~BodyFlag.tracked) || dv.getUint8(9) !== BODY_POINTS || dv.getUint16(10, true)) return null
  return {
    flags: dv.getUint8(1), seq: dv.getUint16(2, true), t: dv.getUint32(4, true), gen: dv.getUint8(8),
    landmarks: Array.from({ length: BODY_POINTS }, (_, i): Vec3 => [0, 1, 2].map(a => dv.getInt16(12 + i * 8 + a * 2, true) / 2000) as Vec3),
    visibility: Array.from({ length: BODY_POINTS }, (_, i) => dv.getUint8(18 + i * 8) / 255),
    presence: Array.from({ length: BODY_POINTS }, (_, i) => dv.getUint8(19 + i * 8) / 255),
  }
}
