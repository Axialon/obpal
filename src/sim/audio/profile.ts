import type { DeviceLogic } from '../devices/types'
import type { Material, Texture, SoundEvent } from './events'
import { TUNING, type Tuning } from './tuning'

export type Space = 'room' | 'hall' | 'yard' | 'underwater' | 'sky'
export interface SoundProfile {
  id: string
  space: Space
  materials: readonly [Material, Material]
  texture: Texture
  pitch: number
  distance: number
  action: string
  tuning: Tuning
  /** Write position, RPM, load, rolling speed, gait, then joint positions into a reused array. */
  read?: (logic: DeviceLogic, n: number, out: Float64Array) => void
  /** Optional per-body continuous sounds, sampled at the same 20 Hz cadence. */
  motion?: (logic: DeviceLogic, n: number, emit: (event: SoundEvent) => void) => void
}

export function profile<L>(data: Omit<SoundProfile, 'read' | 'motion' | 'tuning'>, read?: (logic: L, n: number, out: Float64Array) => void, motion?: (logic: L, n: number, emit: (event: SoundEvent) => void) => void): SoundProfile {
  return { ...data, tuning: TUNING[data.id], read: read ? (logic, n, out) => read(logic as L, n, out) : undefined, motion: motion ? (logic, n, emit) => motion(logic as L, n, emit) : undefined }
}

export function sample(out: Float64Array, x: number, y: number, z: number, rpm = 0, load = 0, rolling = 0, gait = 0, a = 0, b = 0, c = 0, d = 0) {
  out[0] = x; out[1] = y; out[2] = z; out[3] = Math.abs(rpm); out[4] = Math.abs(load); out[5] = Math.abs(rolling); out[6] = gait
  out[7] = a; out[8] = b; out[9] = c; out[10] = d
}
