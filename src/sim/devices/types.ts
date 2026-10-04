/**
 * Device sims (the sim catalogue, /sim/): gadgets a phone drives, each a small control system of its own (CATALOGUE §7)
 * with a few units people claim, one each. A device is data (DeviceSpec: what it is, which controllers suit it, what
 * its tray and the phone's buttons do) and pure logic (DeviceLogic: how each controller's input moves it, and its
 * physics within its limits), with its look in a separate three.js view. Pure: no three.js, no DOM, so node tests it.
 */
import { Mode, type ControllerId, type Layout, type ModeId, type PadState, type Quat, type TrayControl, type UtilityId, type Vec3 } from '@obpal/core'
import type { CategoryId } from '../catalogue'
import type { ControlAim, ControlScope } from '../../control-space'

export interface DeviceSpec {
  /** Stable id: the sim's address (/sim/device/?d=<id>) and its catalogue card. */
  id: string
  name: string
  /** What one unit is called ("Rover 1"), and how many there are to claim; or each its own name. */
  unit: string
  units: number
  unitNames?: string[]
  /** Where the catalogue groups it: Vehicle, Flyer, Camera, Home, Game. */
  kind: string
  /** The catalogue category; older devices use the catalogue's id map. */
  category?: CategoryId
  /** One line for its card. */
  blurb: string
  /** What it shows about the control catalogue, one line. */
  teaches: string
  /** The controllers it suits, best first: the host's `layout.controllers`, so the first opens on the phone. */
  controllers: ControllerId[]
  /** How each of those drives it, a few words each, for the panel and the card. */
  how: Partial<Record<ControllerId, string>>
  /** A profile to suggest (`layout.profile`), where one fits it. */
  profile?: string
  /** The phone's tray: its own actions, beside the Home every device has. */
  tray: TrayControl[]
  /** What physical inputs press here (`layout.buttons`, CATALOGUE §3): on top of each controller's defaults. */
  buttons?: Record<string, string>
  /**
   * The utilities it takes (`layout.utilities`, CATALOGUE §1), where it needs to name them: the phone opens its Hand
   * or Body camera only for a layout that lists it. Left out, the phone offers every motion utility and no camera.
   */
  utilities?: readonly UtilityId[]
  /**
   * Its parts (PROTOCOL §3a): the pieces of a unit the phone's node strip picks one at a time, first to last as the
   * strip shows them, and named sets of them. The unit's own icon heads the strip, for the whole of it.
   */
  parts?: readonly DevicePart[]
  sets?: readonly DeviceSet[]
  icon?: string
}

/** A trackpad gesture a device reads (DeviceInput): the one-finger drag or two-finger pan across or down, the twist, the pinch. */
export type Channel = 'drag.x' | 'drag.y' | 'pan.x' | 'pan.y' | 'twist' | 'pinch'

/**
 * A part of a unit (a boom, a camera head's pan) and the trackpad gestures the device's own mapping reads for it: one,
 * or two (across, then down). Chosen on the phone, it takes the one finger: a drag across or up moves it on, down or
 * left back (a part with two gestures takes the drag as it is). `stick`: it reads the drag as a floating stick (a
 * drive), which centres when the finger moves on to another part. `turn`: the phone's 1:1 turn and its calibrated aim
 * move it too (a camera head).
 */
export interface DevicePart { id: string; name: string; icon: string; channels: readonly Channel[]; stick?: boolean; turn?: boolean }

/** A named set of a unit's parts for one kind of motion; chosen, it drives them together and the others hold. */
export interface DeviceSet { id: string; name: string; icon: string; parts: readonly string[] }

/** The tray button every device has: the unit you hold goes home. */
export const HOME: TrayControl = { id: 'home', label: 'Home', type: 'button', icon: 'reset' }

/** A device's layout for the phone: its controllers (the SDK fills in modes for older phones), tray and buttons. */
export function layoutOf(spec: DeviceSpec): Layout {
  return {
    v: 1,
    controllers: [...spec.controllers],
    tray: [...spec.tray, HOME],
    ...(spec.profile ? { profile: spec.profile } : {}),
    ...(spec.buttons ? { buttons: { ...spec.buttons } } : {}),
    ...(spec.utilities ? { utilities: [...spec.utilities] } : {}),
  }
}

/** Where a pointing phone (the Wii remote, the air mouse) points: on the screen, and as angles since its recentre. */
export interface Pointing {
  /** CSS px on the screen (can be off it). */
  x: number
  y: number
  /** Degrees since the phone's recentre: + right, + up. */
  yaw: number
  pitch: number
  off: boolean
}

/**
 * One participant's input for one frame, whatever controller it uses, as a device reads it. Deltas are since the last
 * frame; presses are what went down since then, in order.
 */
export interface DeviceInput {
  /** Optional camera snapshots, read once with this seat's other input. */
  body?: import('@obpal/host').BodyFrame | null
  hand?: import('@obpal/host').Frame['hand']
  /** The active view's frame, applied once to spatial intent after the controller is read. */
  controlFrame?: import('../vr/intent').InputFrame
  /** Calibrated motion from a current phone; absent for legacy and touch-only clients. */
  space?: ControlAim
  scope?: ControlScope
  /** A calibrated neutral changed this frame; forget derivative gesture history without homing the sim. */
  positioned?: boolean
  /** The watchdog has stopped continuous input; explicit tray actions can still arrive. */
  quiet?: boolean
  /** The catalogue controller in use (CATALOGUE §9.1): what the phone says, else what its mode stands for. */
  face: string
  mode: ModeId
  /** The gamepad and the steering wheel: the pad now, and its buttons that went down since the last frame (bit i). */
  pad: PadState | null
  padPressed: number
  /** The trackpad: a finger on it; one-finger drag and two-finger pan (CSS px, + right and down); pinch (log2); twist (°). */
  touching: boolean
  drag: [number, number]
  pan: [number, number]
  pinch: number
  twist: number
  /** Tilt (the trackpad with the gyro, in its Tilt style): [+ right, + top edge toward the person], −1…1. */
  tilt: [number, number]
  /** 1:1 (the trackpad with the gyro, matching): the phone's turn since the gyro went on, in the view frame; else null. */
  hold: Quat | null
  /** Pointing (the Wii remote, the air mouse), else null. */
  point: Pointing | null
  /** Where that pointing meets the device's floor, [x, z] in metres (the view says which floor), else null. */
  spot: [number, number] | null
  /** 3D (the 3D hand): where the phone is, with its deadman (`touching`); null when it isn't tracking. */
  pose: { p: Vec3; q: Quat; tracked: boolean; touching: boolean; gen: number } | null
  /** Buttons held now: wii-a, wii-b, mouse-left, mouse-right. */
  held: ReadonlySet<string>
  /** Pressed since the last frame: tray buttons, wii-a, wii-plus, wii-minus, mouse-left, mouse-right, mouse-middle, pad (a tap), key-… */
  presses: readonly string[]
  /** The air mouse's wheel since the last frame: 120 a notch, + scrolls down. */
  wheel: number
  /** Typed on the phone's keyboard since the last frame ('\n' is Enter), after deleting `del` characters. */
  text: string
  del: number
  /** Tray toggles and pickers changed since the last frame. */
  values: readonly { id: string; v: number | boolean | string }[]
  /** The phone recentred (its ⌂, or Level in 1:1) since the last frame. */
  recentred: boolean
}

/** Something a device did that the people holding it should feel or see. */
export interface DeviceEvent {
  unit: number
  /** tick: a small confirmation; bump: a knock (rumbles); score: a goal reached; fall: lost it (rumbles hard). */
  kind: 'tick' | 'bump' | 'score' | 'fall'
  /** 0…1, for a bump's rumble. */
  strength?: number
  /** A toast for the holder, and a line for the record. */
  text?: string
  /** Optional physical sound data, measured by the logic at contact or action time. */
  audio?: {
    at?: readonly [number, number, number]
    speed?: number
    impulse?: number
    materials?: readonly [import('../audio/events').Material, import('../audio/events').Material]
    action?: string
    source?: string
    glass?: import('../audio/events').SoundEvent['glass']
    pitch?: number
  }
}

/** A device's behaviour: pure, stepped by the page once a frame. */
export interface DeviceLogic {
  readonly spec: DeviceSpec
  /** One frame: each unit's holder's input (null: nobody holds it, or its input went quiet). dt in seconds. */
  step(inputs: readonly (DeviceInput | null)[], dt: number): void
  /** Send a unit home: where it started, at rest. */
  home(unit: number): void
  /** A unit's live readout for the panel (a speed, a height, a colour). */
  readout(unit: number): string
  /** Authoritative state for action glyphs on the holder's phone. */
  actionState?(unit: number): Record<string, boolean>
  /** Put the scene back as it was (the panel's button, named `resetLabel`), where there's more to it than its units. */
  reset?(): void
  readonly resetLabel?: string
  /** What happened since the last call. */
  drain(): DeviceEvent[]
}

/** An input with nothing happening, as from a phone that just connected (tests start from it). */
export function restInput(face = 'face.gamepad', mode: ModeId = Mode.gamepad): DeviceInput {
  return {
    face, mode, pad: null, padPressed: 0, touching: false, drag: [0, 0], pan: [0, 0], pinch: 0, twist: 0, tilt: [0, 0],
    hold: null, point: null, spot: null, pose: null, held: new Set(), presses: [], wheel: 0, text: '', del: 0, values: [], recentred: false,
  }
}
