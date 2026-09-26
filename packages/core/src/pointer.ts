/**
 * POINTER packet (type 4): where the device points, sent on the unreliable "st" channel beside PAD while a
 * pointing utility is on (catalogue `motion.point`, or `motion.aim` routed to the mouse).
 *
 * Layout (16 bytes, little-endian):
 *   0 u8  header 0x14 (version 1, type 4)    1 u8  flags (b0 valid, b1 relative, b2 edge turn)
 *   2 u16 seq                                4 u32 capture time, microseconds
 *   8 i16 yaw, 0.01° (+ = right)            10 i16 pitch, 0.01° (+ = up)
 *  12 u8  recentre generation               13 u8 reserved      14 u16 reserved
 *
 * Absolute (Wii-style): yaw and pitch are the pointing angles since the device's last recentre, so a lost packet
 * costs nothing and a recentre puts the cursor back in the middle. Hosts project them (CATALOGUE §4).
 * Relative (gyro mouse): the angles only ever grow (wrapping); hosts difference consecutive packets with
 * pointerDelta() and skip the difference across a change of generation.
 */
export const POINTER_HEADER = 0x14
export const POINTER_BYTES = 16

export const PointerFlag = {
  /** The device has an orientation; without it the angles are meaningless. */
  valid: 1,
  /** Only changes carry meaning (integrated turn rate for a mouse), not the absolute angle. */
  relative: 2,
  /** The device asks for the Wii shooter's edge turn (CATALOGUE §4). */
  edgeTurn: 4,
} as const

export interface PointerState {
  flags: number
  seq: number
  /** Capture time on the device session clock, microseconds (u32, wraps). */
  t: number
  /** Degrees, + = right. Absolute since recentre, or an accumulator when `relative`. */
  yaw: number
  /** Degrees, + = up. */
  pitch: number
  /** Increments on each recentre (wraps at 256). */
  gen: number
}

export function emptyPointer(): PointerState {
  return { flags: 0, seq: 0, t: 0, yaw: 0, pitch: 0, gen: 0 }
}

/** Degrees to the wire's 0.01° with wrap-around, so a relative accumulator never overflows. */
const wrap16 = (deg: number) => ((Math.round(deg * 100) % 65536) + 98304) % 65536 - 32768

export function encodePointer(p: PointerState, out = new ArrayBuffer(POINTER_BYTES)): ArrayBuffer {
  const dv = new DataView(out)
  dv.setUint8(0, POINTER_HEADER)
  dv.setUint8(1, p.flags & 0xff)
  dv.setUint16(2, p.seq & 0xffff, true)
  dv.setUint32(4, p.t >>> 0, true)
  dv.setInt16(8, wrap16(p.yaw), true)
  dv.setInt16(10, wrap16(p.pitch), true)
  dv.setUint8(12, p.gen & 0xff)
  dv.setUint8(13, 0)
  dv.setUint16(14, 0, true)
  return out
}

export function decodePointer(buf: ArrayBuffer): PointerState | null {
  if (buf.byteLength < POINTER_BYTES) return null
  const dv = new DataView(buf)
  if (dv.getUint8(0) !== POINTER_HEADER) return null
  return {
    flags: dv.getUint8(1),
    seq: dv.getUint16(2, true),
    t: dv.getUint32(4, true),
    yaw: dv.getInt16(8, true) / 100,
    pitch: dv.getInt16(10, true) / 100,
    gen: dv.getUint8(12),
  }
}

/**
 * Change of aim from packet `b` to packet `a` in degrees, wrap-safe (the wire is 0.01° in an int16).
 * Zero across a recentre (a different generation), so a relative mouse never jumps.
 */
export function pointerDelta(a: PointerState, b: PointerState): [number, number] {
  if (a.gen !== b.gen) return [0, 0]
  const d = (x: number, y: number) => (((Math.round((x - y) * 100) % 65536) + 98304) % 65536 - 32768) / 100
  return [d(a.yaw, b.yaw), d(a.pitch, b.pitch)]
}
