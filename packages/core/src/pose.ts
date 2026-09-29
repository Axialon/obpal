/**
 * POSE packet (type 5): where the device is in space, sent on the unreliable "st" channel while 3D tracking is on
 * (catalogue `motion.track`, mode 6). In the camera mode the device tracks itself with its camera and motion sensors
 * (WebXR on Android), correcting drift with visual tracking. Without it, position is
 * estimated from the phone's own motion (a gyro through an arm model, an accelerometer for push and pull).
 *
 * Layout (32 bytes, little-endian):
 *   0 u8  header 0x15 (version 1, type 5)    1 u8  flags (b0 tracked, b1 touching: the deadman, in the same frame)
 *   2 u16 seq                                4 u32 capture time, microseconds
 *   8 f32 x, 12 f32 y, 16 f32 z: metres in the device's tracking space (y up, origin where tracking began)
 *  20 i16×4 orientation, Q15 quaternion (x, y, z, w): device → tracking space. The device's screen faces +z; its
 *        camera looks along −z; its top edge is +y.
 *  28 u8  generation: a new tracking session (a new origin); hosts re-anchor when it changes
 *  29 u8  source: 0 unknown (legacy), 1 camera, 2 model      30 u16 reserved
 *
 * Positions are absolute within a generation, so a lost packet costs nothing. `tracked` clears while the device has
 * lost track of the world (too dark, too fast, a blank wall): hosts hold still until it returns.
 */
import type { Quat, Vec3 } from './quat'

export const POSE_HEADER = 0x15
export const POSE_BYTES = 32
export const PoseFlag = { tracked: 1, touching: 2 } as const
export type PoseSource = 'camera' | 'model' | 'unknown'

export interface PoseState {
  flags: number
  seq: number
  /** Capture time on the device session clock, microseconds (u32, wraps). */
  t: number
  p: Vec3
  q: Quat
  gen: number
  source: PoseSource
}

const q15 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v * 32767)))

export function encodePose(s: Omit<PoseState, 'source'> & { source?: PoseSource }, out = new ArrayBuffer(POSE_BYTES)): ArrayBuffer {
  const dv = new DataView(out)
  dv.setUint8(0, POSE_HEADER)
  dv.setUint8(1, s.flags & 0xff)
  dv.setUint16(2, s.seq & 0xffff, true)
  dv.setUint32(4, s.t >>> 0, true)
  for (let i = 0; i < 3; i++) dv.setFloat32(8 + i * 4, s.p[i], true)
  for (let i = 0; i < 4; i++) dv.setInt16(20 + i * 2, q15(s.q[i]), true)
  dv.setUint8(28, s.gen & 0xff)
  dv.setUint8(29, s.source === 'camera' ? 1 : s.source === 'model' ? 2 : 0)
  dv.setUint16(30, 0, true)
  return out
}

export function decodePose(buf: ArrayBuffer): PoseState | null {
  if (buf.byteLength < POSE_BYTES) return null
  const dv = new DataView(buf)
  if (dv.getUint8(0) !== POSE_HEADER) return null
  const p: Vec3 = [dv.getFloat32(8, true), dv.getFloat32(12, true), dv.getFloat32(16, true)]
  if (!p.every(Number.isFinite) || p.some((v) => Math.abs(v) > 1000)) return null
  const q = [0, 1, 2, 3].map((i) => dv.getInt16(20 + i * 2, true) / 32767) as Quat
  const l = Math.hypot(...q) || 1
  const source = dv.getUint8(29)
  return { flags: dv.getUint8(1), seq: dv.getUint16(2, true), t: dv.getUint32(4, true), p, q: q.map((v) => v / l) as Quat, gen: dv.getUint8(28), source: source === 1 ? 'camera' : source === 2 ? 'model' : 'unknown' }
}
