/**
 * PAD packet (type 2): a full game controller in the W3C "standard" gamepad layout (Xbox-style),
 * sent on the unreliable "st" channel alongside or instead of STATE while a device is in gamepad mode.
 *
 * Layout (24 bytes, little-endian):
 *   0 u8  header 0x12 (version 1, type 2)    1 u8  flags (b0 gyro aim, b1 tilt steer, b2 point)
 *   2 u16 seq                                4 u32 capture time, microseconds
 *   8 u32 buttons (bit i = standard button i)
 *  12 i16 LX  14 i16 LY  16 i16 RX  18 i16 RY  (-1..1 as Q15; +X right, +Y down, as in the Gamepad API)
 *  20 u8  LT  21 u8 RT (0..1 as /255)       22 u16 reserved
 */
export const PAD_HEADER = 0x12
export const PAD_BYTES = 24

/** Standard-mapping button indices (https://w3c.github.io/gamepad/#remapping). */
export const PadButton = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, View: 8, Menu: 9, L3: 10, R3: 11,
  Up: 12, Down: 13, Left: 14, Right: 15, Guide: 16,
} as const
export type PadButtonId = (typeof PadButton)[keyof typeof PadButton]
export const PAD_BUTTON_COUNT = 17

/** flags: b0 gyro aim is on, b1 tilt steering is on, b2 the Wii-style pointer is on (POINTER packets follow). */
export const PadFlag = { gyroAim: 1, tiltSteer: 2, point: 4 } as const

export interface PadState {
  flags: number
  seq: number
  /** Capture time on the device session clock, microseconds (u32, wraps). */
  t: number
  buttons: number
  /** [LX, LY, RX, RY] in -1..1; +Y is down, matching the Gamepad API. */
  axes: [number, number, number, number]
  /** [LT, RT] in 0..1. */
  triggers: [number, number]
}

export function emptyPad(): PadState {
  return { flags: 0, seq: 0, t: 0, buttons: 0, axes: [0, 0, 0, 0], triggers: [0, 0] }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

export function encodePad(p: PadState, out = new ArrayBuffer(PAD_BYTES)): ArrayBuffer {
  const dv = new DataView(out)
  dv.setUint8(0, PAD_HEADER)
  dv.setUint8(1, p.flags & 0xff)
  dv.setUint16(2, p.seq & 0xffff, true)
  dv.setUint32(4, p.t >>> 0, true)
  dv.setUint32(8, p.buttons >>> 0, true)
  for (let i = 0; i < 4; i++) dv.setInt16(12 + i * 2, Math.round(clamp(p.axes[i], -1, 1) * 32767), true)
  dv.setUint8(20, Math.round(clamp(p.triggers[0], 0, 1) * 255))
  dv.setUint8(21, Math.round(clamp(p.triggers[1], 0, 1) * 255))
  dv.setUint16(22, 0, true)
  return out
}

export function decodePad(buf: ArrayBuffer): PadState | null {
  if (buf.byteLength < PAD_BYTES) return null
  const dv = new DataView(buf)
  if (dv.getUint8(0) !== PAD_HEADER) return null
  return {
    flags: dv.getUint8(1),
    seq: dv.getUint16(2, true),
    t: dv.getUint32(4, true),
    buttons: dv.getUint32(8, true),
    axes: [dv.getInt16(12, true) / 32767, dv.getInt16(14, true) / 32767, dv.getInt16(16, true) / 32767, dv.getInt16(18, true) / 32767],
    triggers: [dv.getUint8(20) / 255, dv.getUint8(21) / 255],
  }
}

/** Packet type from the first byte (0x11 STATE, 0x12 PAD, 0x14 POINTER, …) without decoding. */
export const packetType = (buf: ArrayBuffer) => (buf.byteLength ? new DataView(buf).getUint8(0) : 0)
