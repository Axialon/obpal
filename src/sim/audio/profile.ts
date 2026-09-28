import type { DeviceLogic } from '../devices/types'
import type { Material, Texture } from './events'

export type Space = 'room' | 'hall' | 'yard' | 'underwater' | 'sky'
export interface SoundProfile {
  id: string
  space: Space
  materials: readonly [Material, Material]
  texture: Texture
  pitch: number
  distance: number
  action: string
  /** Write position, RPM, load, rolling speed, gait, then joint positions into a reused array. */
  read?: (logic: DeviceLogic, n: number, out: Float64Array) => void
}

export function profile<L>(data: Omit<SoundProfile, 'read'>, read?: (logic: L, n: number, out: Float64Array) => void): SoundProfile {
  return { ...data, read: read ? (logic, n, out) => read(logic as L, n, out) : undefined }
}

export function sample(out: Float64Array, x: number, y: number, z: number, rpm = 0, load = 0, rolling = 0, gait = 0, a = 0, b = 0, c = 0, d = 0) {
  out[0] = x; out[1] = y; out[2] = z; out[3] = Math.abs(rpm); out[4] = Math.abs(load); out[5] = Math.abs(rolling); out[6] = gait
  out[7] = a; out[8] = b; out[9] = c; out[10] = d
}
