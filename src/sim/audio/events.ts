/** Logic-owned sound events. Positions are metres in the scene's world frame. */
import type { DeviceEvent } from '../devices/types'

export type Material = 'metal' | 'rubber' | 'tile' | 'wood' | 'plastic' | 'glass' | 'water'
export type Position = readonly [number, number, number]
export type Texture = 'motor' | 'engine' | 'rotor' | 'servo' | 'hydraulic' | 'roll' | 'scrape' | 'water' | 'air'
export type SoundKind = 'contact' | 'sustain' | 'motor' | 'action' | 'footstep'
export interface SoundEvent {
  kind: SoundKind
  source: string
  at: Position
  who?: string
  strength: number
  speed?: number
  impulse?: number
  materials?: readonly [Material, Material]
  texture?: Texture
  rpm?: number
  load?: number
  action?: string
}

export class SoundBus {
  private listeners = new Set<(event: SoundEvent) => void>()
  on(listener: (event: SoundEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: SoundEvent) { for (const listener of this.listeners) listener(event) }
}

export const unit = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0

export function deviceEvent(e: DeviceEvent, source: string, at: Position, who?: string): SoundEvent {
  return {
    kind: e.kind === 'bump' || e.kind === 'fall' ? 'contact' : 'action', source, at, who,
    strength: unit(e.strength ?? (e.kind === 'fall' ? 1 : e.kind === 'score' ? 0.6 : 0.3)),
    speed: e.audio?.speed, impulse: e.audio?.impulse, materials: e.audio?.materials,
    action: e.audio?.action ?? (e.kind === 'score' ? 'score' : 'tick'),
  }
}
