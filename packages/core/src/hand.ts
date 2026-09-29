/**
 * HAND packet (type 6): one camera-tracked hand, sent on the unreliable "st" channel. Palm translation is a
 * monocular estimate using an approximate camera field of view, not a measured absolute world position.
 * Coordinates use x right, y up and z toward the camera; landmarks are metres about the hand's centre.
 */
import type { Vec3 } from './quat'

export const HAND_HEADER = 0x16
export const HAND_BYTES = 144
export const HandFlag = { tracked: 1 } as const
export const HandGesture = { pinch: 1, grip: 2, point: 4 } as const
export type Handedness = 'left' | 'right' | 'unknown'

export interface HandState {
  flags: number
  seq: number
  /** Capture time on the device session clock, microseconds (u32, wraps). */
  t: number
  /** A new tracking identity or origin (u8, wraps); sequence numbers continue across changes. */
  gen: number
  handedness: Handedness
  confidence: number
  gestures: number
  /** Estimated palm translation in camera metres, using an approximate field of view. */
  p: Vec3
  /** The 21 hand-centred world landmarks in metres, with camera-aligned axes. */
  landmarks: Vec3[]
}

const SCALE = 2000
const GESTURES = HandGesture.pinch | HandGesture.grip | HandGesture.point
const uint = (v: number, max: number) => Number.isInteger(v) && v >= 0 && v <= max

/** Encode a complete hand; invalid values throw instead of wrapping or clamping coordinates. */
export function encodeHand(s: HandState, out = new ArrayBuffer(HAND_BYTES)): ArrayBuffer {
  if (out.byteLength !== HAND_BYTES) throw new RangeError('HAND output must be 144 bytes')
  if (!uint(s.flags, HandFlag.tracked) || !uint(s.seq, 0xffff) || !uint(s.t, 0xffffffff) || !uint(s.gen, 0xff)
    || !uint(s.gestures, GESTURES) || !Number.isFinite(s.confidence) || s.confidence < 0 || s.confidence > 1
    || (s.handedness !== 'unknown' && s.handedness !== 'left' && s.handedness !== 'right')) {
    throw new RangeError('Invalid HAND fields')
  }
  if (!Array.isArray(s.landmarks) || s.landmarks.length !== 21) throw new RangeError('HAND needs 21 landmarks')
  const points = [s.p, ...s.landmarks]
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 3) throw new RangeError('HAND positions must be Vec3 tuples')
    for (let i = 0; i < 3; i++) {
      if (!Number.isFinite(p[i]) || p[i] < -32768 / SCALE || p[i] > 32767 / SCALE) {
        throw new RangeError('HAND positions must fit signed i16 metres at scale 2000')
      }
    }
  }
  const dv = new DataView(out)
  dv.setUint8(0, HAND_HEADER)
  dv.setUint8(1, s.flags)
  dv.setUint16(2, s.seq, true)
  dv.setUint32(4, s.t, true)
  dv.setUint8(8, s.gen)
  dv.setUint8(9, s.handedness === 'left' ? 1 : s.handedness === 'right' ? 2 : 0)
  dv.setUint8(10, Math.round(s.confidence * 255))
  dv.setUint8(11, s.gestures)
  for (let n = 0; n < points.length; n++) {
    for (let i = 0; i < 3; i++) dv.setInt16(12 + n * 6 + i * 2, Math.round(points[n][i] * SCALE), true)
  }
  return out
}

export function decodeHand(buf: ArrayBuffer): HandState | null {
  if (buf.byteLength !== HAND_BYTES) return null
  const dv = new DataView(buf)
  if (dv.getUint8(0) !== HAND_HEADER) return null
  const flags = dv.getUint8(1), handedness = dv.getUint8(9), gestures = dv.getUint8(11)
  if ((flags & ~HandFlag.tracked) !== 0 || handedness > 2 || (gestures & ~GESTURES) !== 0) return null
  const point = (off: number): Vec3 => [dv.getInt16(off, true) / SCALE, dv.getInt16(off + 2, true) / SCALE, dv.getInt16(off + 4, true) / SCALE]
  return {
    flags, seq: dv.getUint16(2, true), t: dv.getUint32(4, true), gen: dv.getUint8(8),
    handedness: handedness === 1 ? 'left' : handedness === 2 ? 'right' : 'unknown',
    confidence: dv.getUint8(10) / 255, gestures, p: point(12),
    landmarks: Array.from({ length: 21 }, (_, i) => point(18 + i * 6)),
  }
}
