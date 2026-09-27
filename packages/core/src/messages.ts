import type { ModeId, TierId } from './state'

/** A control in a host-defined tray. The phone renders it; the host decides what its id means. */
export interface TrayControl {
  id: string
  label: string
  /**
   * button: sends btn{tap}; toggle: sends value{bool}; select: opens a picker, sends value{option value};
   * keyboard: opens the device's own keyboard, whose typing arrives as text{s, del} and whose key row (Esc, Tab,
   * arrows, Enter) as btn{key-<KeyboardEvent.code>, tap}.
   */
  type?: 'button' | 'toggle' | 'select' | 'keyboard'
  /** A standard icon name (reset, frame, spin, grid, glow, models, …) the device may draw instead of text. */
  icon?: string
  /** Options for type 'select', optionally grouped under headings. image: https URL thumbnail; glyph/color: drawn thumbnail. */
  options?: { value: string; label: string; group?: string; detail?: string; image?: string; glyph?: string; color?: string }[]
  /** select: options can also be added alongside the current choice; the device offers "add" and sends value{…, add: true}. */
  add?: boolean
  /** stop: a safety stop (a robot's e-stop). The device draws it in red, as words, never as an icon alone. */
  tone?: 'stop'
}

/** The device's hardware buttons, as the phone controller reads them (src/controller/hardware.ts). */
export type HardwareKey = 'primary' | 'secondary' | 'next' | 'prev'

export interface Layout {
  v: 1
  tray: TrayControl[]
  /** Modes the host supports, in display order. */
  modes?: ModeId[]
  /** Catalogue utilities the host accepts (CATALOGUE §1); absent means all of them. */
  utilities?: string[]
  /** A catalogue profile the host suggests for what it controls right now (CATALOGUE §3). */
  profile?: string
  /**
   * Tray buttons the device's hardware buttons press (CATALOGUE §1): primary is volume up, Enter or a headset press;
   * secondary is volume down or Esc; next and prev are arrows, Page Up/Down or a headset's skip. A bound button sends
   * btn{tap} when pressed. Unbound ones keep the mode's own use; gamepad mode keeps them as A, B and the d-pad.
   */
  keys?: Partial<Record<HardwareKey, string>>
  /**
   * The Point face. wii (the default): A selects, hold B to grab, - / + zoom, home centres. mouse: a mouse's
   * Left and Right buttons (btn mouse-left / mouse-right, down and up) either side of B as the middle bar (hold to
   * scroll, or drag a finger along it), with - / + to zoom.
   */
  point?: 'wii' | 'mouse'
  /**
   * Send toss{v} when the device is flicked upward, screen level, the way you'd throw a ball off a tray: v is how fast
   * it went up, m/s. For hosts that bounce things.
   */
  toss?: boolean
}

/** The fastest toss{v} a device reports (m/s). */
export const MAX_TOSS = 4

/** The longest text{s} a device sends at once, and the most characters one may delete. */
export const MAX_TEXT = 256

export interface Caps {
  tier: TierId
  sensorApi: 'events' | 'generic' | 'none'
  haptics: 'vibrate' | 'ios-switch' | 'none'
  platform: string
}

/**
 * A remembered pairing, handed to the device in `welcome` after an online pairing (inside the DTLS-protected
 * channel, so only the two peers ever see the key). It is what a later direct LAN connection is built on.
 */
export interface PairGrant { id: string; key: string }

/** Someone in a shared scene (CATALOGUE §5): a device, or the screen itself (id "host"). */
export interface ScenePerson { id: string; name: string; color: string; lead?: boolean }

/**
 * Something in a shared scene one participant at a time can control. `parent`: the node this one is part of (a joint
 * of an arm). Whoever holds the parent controls this node too, so neither can be taken while the other is held.
 */
export interface SceneNode { id: string; name: string; kind: string; group?: string; parent?: string }

/** Longest node id a device may send in `claim`. */
export const MAX_NODE_ID = 64

/** Reliable control-channel messages (JSON on the "ctl" DataChannel). Unknown fields are ignored. */
export type DeviceMsg =
  /** pair: the pairing id when connecting through a direct LAN code. */
  | { t: 'hello'; proto: number; caps: Caps; mac: string; name: string; pair?: string }
  | { t: 'btn'; id: string; ev: 'tap' | 'down' | 'up' | 'double' | 'long' }
  /** Typing on the device's keyboard (a `keyboard` tray control): delete `del` characters before the caret, then type `s` ('\n' is Enter). */
  | { t: 'text'; s: string; del?: number }
  /** The device was flicked upward (the layout asked for `toss`): how fast it went up, m/s, at most MAX_TOSS. */
  | { t: 'toss'; v: number }
  | { t: 'value'; id: string; v: number | boolean | string; add?: boolean }
  | { t: 'mode'; m: ModeId }
  | { t: 'recenter' }
  /** Claim a node listed in `scene` (null releases what this device holds). */
  | { t: 'claim'; node: string | null }
  | { t: 'ping'; t0: number }
  | { t: 'bye' }

export type HostMsg =
  /** pair: present when the host remembers this device (it can reconnect over the LAN without the room service). */
  | { t: 'welcome'; proto: number; name: string; layout: Layout; pair?: PairGrant }
  | { t: 'layout'; layout: Layout }
  | { t: 'state'; values: Record<string, number | boolean | string> }
  | { t: 'feedback'; haptic?: 'tick' | 'bump'; toast?: string }
  | { t: 'pong'; t0: number }
  /**
   * A shared scene: who is in it, what can be controlled (omitted when unchanged) and who holds what (node id ->
   * participant id). `you` is the receiver's own id.
   */
  | { t: 'scene'; you: string; people: ScenePerson[]; nodes?: SceneNode[]; held: Record<string, string> }
  /** removed: the host removed this device, which must not rejoin by itself. full: the scene has no free place. */
  | { t: 'lock'; reason: 'taken-over' | 'host-closed' | 'rejected' | 'removed' | 'full' }
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
