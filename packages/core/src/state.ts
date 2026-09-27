import type { Quat, Vec3 } from './quat'

/** Wire protocol version implemented by this package. */
export const PROTO = 1
export const STATE_BYTES = 76
export const STATE_HEADER = 0x11 // high nibble: version 1, low nibble: type 1 (STATE)

export const Flag = {
  quatValid: 1, gyroValid: 2, gravValid: 4, dup: 8, clutch: 16, touching: 32, tsFromSensor: 64, lowPower: 128,
} as const

/** track: 6-DOF, the device's position and orientation in space (POSE packets beside STATE; see ./pose.ts). */
export const Mode = { hold: 0, orbit: 1, point: 2, tilt: 3, pad: 4, gamepad: 5, track: 6 } as const
export type ModeId = (typeof Mode)[keyof typeof Mode]
export const Tier = { touch: 0, tilt: 1, compass: 2, gyro: 3 } as const
export type TierId = (typeof Tier)[keyof typeof Tier]

/** Absolute controller state. Accumulators only ever grow (wrapping), so lost packets cost nothing. */
export interface State {
  flags: number
  seq: number
  /** Capture time on the device session clock, microseconds (u32, wraps). */
  t: number
  mode: ModeId
  grab: number
  tier: TierId
  /** Screen orientation angle / 90 (0..3). */
  screen: number
  touches: number
  qAbs: Quat
  qRel: Quat
  /** Angular velocity, rad/s, screen frame. */
  gyro: Vec3
  /** Unit "up" vector in the screen frame. */
  grav: Vec3
  /** Aim accumulators in degrees: [yaw (+ = left), pitch (+ = up)]. */
  aim: [number, number]
  /** One-finger pad accumulator, CSS px. */
  pad1: [number, number]
  /** Two-finger pan accumulator, CSS px. */
  pad2: [number, number]
  /** Pinch accumulator, log2(scale). */
  zoom: number
  /** Twist accumulator, degrees. */
  twist: number
  joy: [number, number]
  tilt: [number, number]
  buttons: number
}

export function emptyState(): State {
  return {
    flags: 0, seq: 0, t: 0, mode: Mode.hold, grab: 0, tier: Tier.touch, screen: 0, touches: 0,
    qAbs: [0, 0, 0, 1], qRel: [0, 0, 0, 1], gyro: [0, 0, 0], grav: [0, 0, 1],
    aim: [0, 0], pad1: [0, 0], pad2: [0, 0], zoom: 0, twist: 0, joy: [0, 0], tilt: [0, 0], buttons: 0,
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const q15 = (v: number) => clamp(Math.round(v * 32767), -32767, 32767)
const i8 = (v: number) => clamp(Math.round(v * 127), -127, 127)
const wrap16 = (v: number) => ((Math.round(v) % 65536) + 98304) % 65536 - 32768
const wrap32 = (v: number) => Math.round(v) | 0

function putQuat(dv: DataView, off: number, q: Quat) {
  const s = q[3] < 0 ? -1 : 1
  for (let i = 0; i < 4; i++) dv.setInt16(off + i * 2, q15(q[i] * s), true)
}
function getQuat(dv: DataView, off: number): Quat {
  const q: Quat = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) q[i] = dv.getInt16(off + i * 2, true) / 32767
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

export function encodeState(s: State, out = new ArrayBuffer(STATE_BYTES)): ArrayBuffer {
  const dv = new DataView(out)
  dv.setUint8(0, STATE_HEADER)
  dv.setUint8(1, s.flags & 0xff)
  dv.setUint16(2, s.seq & 0xffff, true)
  dv.setUint32(4, s.t >>> 0, true)
  dv.setUint8(8, s.mode)
  dv.setUint8(9, s.grab & 0xff)
  dv.setUint8(10, (s.tier & 3) | ((s.screen & 3) << 2))
  dv.setUint8(11, Math.min(255, s.touches))
  putQuat(dv, 12, s.qAbs)
  putQuat(dv, 20, s.qRel)
  for (let i = 0; i < 3; i++) dv.setInt16(28 + i * 2, clamp(Math.round(s.gyro[i] * 1000), -32767, 32767), true)
  for (let i = 0; i < 3; i++) dv.setInt16(34 + i * 2, q15(s.grav[i]), true)
  dv.setInt32(40, wrap32(s.aim[0] * 1000), true)
  dv.setInt32(44, wrap32(s.aim[1] * 1000), true)
  dv.setInt32(48, wrap32(s.pad1[0] * 16), true)
  dv.setInt32(52, wrap32(s.pad1[1] * 16), true)
  dv.setInt32(56, wrap32(s.pad2[0] * 16), true)
  dv.setInt32(60, wrap32(s.pad2[1] * 16), true)
  dv.setInt16(64, wrap16(s.zoom * 4096), true)
  dv.setInt16(66, wrap16(s.twist * 100), true)
  dv.setInt8(68, i8(s.joy[0]))
  dv.setInt8(69, i8(s.joy[1]))
  dv.setInt8(70, i8(s.tilt[0]))
  dv.setInt8(71, i8(s.tilt[1]))
  dv.setUint32(72, s.buttons >>> 0, true)
  return out
}

/** Decoded state keeps accumulators in raw wire units so receivers can difference them with wrap-around. */
export interface WireState extends State {
  raw: { aim: [number, number]; pad1: [number, number]; pad2: [number, number]; zoom: number; twist: number }
}

export function decodeState(buf: ArrayBuffer): WireState | null {
  if (buf.byteLength < STATE_BYTES) return null
  const dv = new DataView(buf)
  if (dv.getUint8(0) !== STATE_HEADER) return null
  const tb = dv.getUint8(10)
  const raw = {
    aim: [dv.getInt32(40, true), dv.getInt32(44, true)] as [number, number],
    pad1: [dv.getInt32(48, true), dv.getInt32(52, true)] as [number, number],
    pad2: [dv.getInt32(56, true), dv.getInt32(60, true)] as [number, number],
    zoom: dv.getInt16(64, true),
    twist: dv.getInt16(66, true),
  }
  return {
    flags: dv.getUint8(1),
    seq: dv.getUint16(2, true),
    t: dv.getUint32(4, true),
    mode: dv.getUint8(8) as ModeId,
    grab: dv.getUint8(9),
    tier: (tb & 3) as TierId,
    screen: (tb >> 2) & 3,
    touches: dv.getUint8(11),
    qAbs: getQuat(dv, 12),
    qRel: getQuat(dv, 20),
    gyro: [dv.getInt16(28, true) / 1000, dv.getInt16(30, true) / 1000, dv.getInt16(32, true) / 1000],
    grav: [dv.getInt16(34, true) / 32767, dv.getInt16(36, true) / 32767, dv.getInt16(38, true) / 32767],
    aim: [raw.aim[0] / 1000, raw.aim[1] / 1000],
    pad1: [raw.pad1[0] / 16, raw.pad1[1] / 16],
    pad2: [raw.pad2[0] / 16, raw.pad2[1] / 16],
    zoom: raw.zoom / 4096,
    twist: raw.twist / 100,
    joy: [dv.getInt8(68) / 127, dv.getInt8(69) / 127],
    tilt: [dv.getInt8(70) / 127, dv.getInt8(71) / 127],
    buttons: dv.getUint32(72, true),
    raw,
  }
}

/** Serial-number comparison for u16 sequence numbers: is a newer than b? */
export function seqNewer(a: number, b: number): boolean {
  const d = (a - b + 65536) % 65536
  return d !== 0 && d < 32768
}

/** Wrap-safe differences of raw accumulators, returned in natural units. */
export function accumDelta(a: WireState, b: WireState) {
  const d32 = (x: number, y: number) => (x - y) | 0
  const d16 = (x: number, y: number) => ((x - y + 98304) % 65536) - 32768
  return {
    aim: [d32(a.raw.aim[0], b.raw.aim[0]) / 1000, d32(a.raw.aim[1], b.raw.aim[1]) / 1000] as [number, number],
    pad1: [d32(a.raw.pad1[0], b.raw.pad1[0]) / 16, d32(a.raw.pad1[1], b.raw.pad1[1]) / 16] as [number, number],
    pad2: [d32(a.raw.pad2[0], b.raw.pad2[0]) / 16, d32(a.raw.pad2[1], b.raw.pad2[1]) / 16] as [number, number],
    zoom: d16(a.raw.zoom, b.raw.zoom) / 4096,
    twist: d16(a.raw.twist, b.raw.twist) / 100,
  }
}
