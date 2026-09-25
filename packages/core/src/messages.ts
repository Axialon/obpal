import type { ModeId, TierId } from './state'

/** A control in a host-defined tray. The phone renders it; the host decides what its id means. */
export interface TrayControl {
  id: string
  label: string
  /** button: sends btn{tap}; toggle: sends value{bool}; select: opens a picker, sends value{option value}. */
  type?: 'button' | 'toggle' | 'select'
  /** A standard icon name (reset, frame, spin, grid, glow, models, …) the device may draw instead of text. */
  icon?: string
  /** Options for type 'select', optionally grouped under headings. image: https URL thumbnail; glyph/color: drawn thumbnail. */
  options?: { value: string; label: string; group?: string; detail?: string; image?: string; glyph?: string; color?: string }[]
  /** select: options can also be added alongside the current choice; the device offers "add" and sends value{…, add: true}. */
  add?: boolean
}

export interface Layout {
  v: 1
  tray: TrayControl[]
  /** Modes the host supports, in display order. */
  modes?: ModeId[]
}

export interface Caps {
  tier: TierId
  sensorApi: 'events' | 'generic' | 'none'
  haptics: 'vibrate' | 'ios-switch' | 'none'
  platform: string
}

/** Reliable control-channel messages (JSON on the "ctl" DataChannel). Unknown fields are ignored. */
export type DeviceMsg =
  | { t: 'hello'; proto: number; caps: Caps; mac: string; name: string }
  | { t: 'btn'; id: string; ev: 'tap' | 'down' | 'up' | 'double' | 'long' }
  | { t: 'value'; id: string; v: number | boolean | string; add?: boolean }
  | { t: 'mode'; m: ModeId }
  | { t: 'recenter' }
  | { t: 'ping'; t0: number }
  | { t: 'bye' }

export type HostMsg =
  | { t: 'welcome'; proto: number; name: string; layout: Layout }
  | { t: 'layout'; layout: Layout }
  | { t: 'state'; values: Record<string, number | boolean | string> }
  | { t: 'feedback'; haptic?: 'tick' | 'bump'; toast?: string }
  | { t: 'pong'; t0: number }
  | { t: 'lock'; reason: 'taken-over' | 'host-closed' | 'rejected' }
  /** Rumble (Gamepad API 'dual-rumble' semantics): magnitudes 0..1 for duration ms. */
  | { t: 'rumble'; strong: number; weak: number; ms: number }

/** Signaling envelope exchanged with the room service (JSON over WebSocket). */
export type SignalIn =
  | { t: 'welcome'; id: string; role: 'host' | 'device'; host: boolean }
  | { t: 'peer'; ev: 'join' | 'leave'; id: string; role?: 'host' | 'device' }
  | { t: 'sig'; from: string; d: SignalPayload }
  | { t: 'error'; code: string }

export type SignalPayload =
  | { offer: RTCSessionDescriptionInit }
  | { answer: RTCSessionDescriptionInit }
  | { cand: RTCIceCandidateInit }
