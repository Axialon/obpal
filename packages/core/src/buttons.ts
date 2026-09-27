/**
 * Physical buttons as controller buttons (CATALOGUE §1 and §3; spec/RESEARCH-BUTTONS.md, "Bindings"): the ids a device
 * names its physical inputs by, the controls each controller lets them press, the defaults, the smart defaults for a
 * kind of device the phone recognises from what it sends, and how the layers of bindings resolve. The device presses
 * what a binding names, exactly as a thumb would, so nothing new goes on the wire.
 *
 * An input id is `<source>:<name>`:
 *  - `key:<code>`: a key by its physical code (`key:Enter`, `key:PageDown`, `key:AudioVolumeUp`); the key value where the
 *    browser gives no code, else the legacy keyCode (`key:#175`). Keyboards, remotes, clickers, a selfie remote's Enter.
 *  - `media:<action>`: a Media Session action (headset and earbud buttons). Play and pause are one press whose meaning
 *    flips with the playback state, so both are `media:playpause`; two presses are `media:nexttrack`, three
 *    `media:previoustrack`.
 *  - `pad:b<i>`, `pad:a<i>+`, `pad:a<i>-`: a pad's button, or an axis pushed past half way, by the standard mapping's
 *    index; `pad:raw:…` for a pad whose layout the browser doesn't know.
 *  - `back`: the Back button or gesture, caught by the page.
 * Data and pure functions only (no DOM): the phone and the catalogue builder share them.
 */
import type { HardwareKey, Layout } from './messages'

export type InputSource = 'volume' | 'keys' | 'media' | 'pad' | 'back'

/** Every well-formed input id (a profile's `buttons` keys, `layout.buttons`). */
export const INPUT_ID = /^(key:(#\d{1,3}|[A-Za-z0-9]{1,32})|media:[a-z]{2,24}|pad:(raw:)?(b\d{1,2}|a\d{1,2}[+-])|back)$/
export const isInputId = (x: unknown): x is string => typeof x === 'string' && INPUT_ID.test(x)

export interface KeyLike { key: string; code: string; keyCode: number }

/** The volume keys under every name browsers have used: the UI Events names, and Gecko's old ones. */
const VOLUME: Record<string, string> = {
  AudioVolumeUp: 'AudioVolumeUp', VolumeUp: 'AudioVolumeUp',
  AudioVolumeDown: 'AudioVolumeDown', VolumeDown: 'AudioVolumeDown',
  AudioVolumeMute: 'AudioVolumeMute', VolumeMute: 'AudioVolumeMute',
}
/** Their legacy keyCodes: Chromium's and WebKit's (Windows virtual keys 173–175), then Gecko's (181–183). */
const VOLUME_CODES: Record<number, string> = {
  173: 'AudioVolumeMute', 174: 'AudioVolumeDown', 175: 'AudioVolumeUp',
  181: 'AudioVolumeMute', 182: 'AudioVolumeDown', 183: 'AudioVolumeUp',
}
const NAME = /^[A-Za-z0-9]{1,32}$/

export function keyInput(e: KeyLike): string {
  const volume = VOLUME[e.code] ?? VOLUME[e.key] ?? VOLUME_CODES[e.keyCode]
  if (volume) return `key:${volume}`
  if (NAME.test(e.code) && e.code !== 'Unidentified') return `key:${e.code}`
  if (e.key === ' ') return 'key:Space'
  if (NAME.test(e.key) && e.key !== 'Unidentified') return `key:${e.key}`
  return `key:#${Math.min(999, Math.max(0, e.keyCode | 0))}`
}

export const mediaInput = (action: string) => `media:${action === 'play' || action === 'pause' ? 'playpause' : action}`
export const padButton = (i: number, standard: boolean) => `pad:${standard ? '' : 'raw:'}b${i}`
export const padAxis = (i: number, dir: 1 | -1, standard: boolean) => `pad:${standard ? '' : 'raw:'}a${i}${dir > 0 ? '+' : '-'}`

export function sourceOf(id: string): InputSource {
  if (id === 'back') return 'back'
  if (id.startsWith('key:AudioVolume')) return 'volume'
  if (id.startsWith('key:')) return 'keys'
  if (id.startsWith('media:')) return 'media'
  return 'pad'
}

/** A media input and Back arrive as one event, with no release: they tap, and can't hold anything. */
export const tapsOnly = (id: string) => id === 'back' || id.startsWith('media:')

const KEY_LABELS: Record<string, string> = {
  AudioVolumeUp: 'Vol+', AudioVolumeDown: 'Vol−', AudioVolumeMute: 'Mute',
  Enter: 'Enter', NumpadEnter: 'Enter', Space: 'Space', Escape: 'Esc', Backspace: '⌫', Tab: 'Tab', Delete: 'Del',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End',
  Period: '.', Comma: ',', Slash: '/', Minus: '-', Equal: '=',
  MediaPlayPause: 'Play', MediaPlay: 'Play', MediaPause: 'Pause', MediaStop: 'Stop', MediaTrackNext: 'Next', MediaTrackPrevious: 'Prev',
  MediaFastForward: 'Fwd', MediaRewind: 'Rew', BrowserBack: 'Back', BrowserForward: 'Fwd', Camera: 'Cam', Power: 'Power',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
  MetaLeft: 'Meta', MetaRight: 'Meta', CapsLock: 'Caps', ContextMenu: 'Menu',
}
const MEDIA_LABELS: Record<string, string> = {
  playpause: 'Play', stop: 'Stop', nexttrack: 'Next', previoustrack: 'Prev', seekforward: 'Fwd', seekbackward: 'Rew',
  seekto: 'Seek', skipad: 'Skip', hangup: 'Hang up', togglemicrophone: 'Mic', togglecamera: 'Cam',
  togglescreenshare: 'Share', previousslide: 'Slide−', nextslide: 'Slide+', enterpictureinpicture: 'PiP', voiceactivity: 'Voice',
}
/** The standard mapping's buttons by position, with the Xbox names ob.Pal's own pad uses. */
const PAD_LABELS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', '↑', '↓', '←', '→', 'Home']
/** The standard mapping's sticks: axes 0–1 the left, 2–3 the right. */
const STICK_LABELS = [['L←', 'L→'], ['L↑', 'L↓'], ['R←', 'R→'], ['R↑', 'R↓']]

/** An input's name, short enough for a corner of a button ("Enter" on A). */
export function labelOf(id: string): string {
  if (id === 'back') return 'Back'
  const [source, ...rest] = id.split(':')
  const name = rest.join(':')
  if (source === 'key') {
    if (KEY_LABELS[name]) return KEY_LABELS[name]
    const m = /^(?:Key|Digit)(.)$/.exec(name) ?? /^Numpad(\d)$/.exec(name)
    if (m) return name.startsWith('Numpad') ? `Num${m[1]}` : m[1]
    if (name.startsWith('#')) return `Key ${name.slice(1)}`
    return name
  }
  if (source === 'media') return MEDIA_LABELS[name] ?? name
  const raw = name.startsWith('raw:')
  const m = /^(?:raw:)?([ab])(\d+)([+-]?)$/.exec(name)
  if (!m) return id
  const i = Number(m[2])
  if (m[1] === 'b') return !raw && PAD_LABELS[i] ? PAD_LABELS[i] : `B${i}`
  const stick = !raw && STICK_LABELS[i]
  return stick ? stick[m[3] === '+' ? 1 : 0] : `Axis ${i}${m[3]}`
}

/** Headset presses by how many: one is play/pause, two the next track, three the previous. */
const PRESSES: Record<string, number> = { 'media:playpause': 1, 'media:nexttrack': 2, 'media:previoustrack': 3 }

/** An input as a badge shows it: a headset's presses by count (1×, 2×, 3×), anything else by its name. */
export const badgeOf = (id: string) => (PRESSES[id] ? `${PRESSES[id]}×` : labelOf(id))

/** An input as a list of options says it: "2 presses" for a headset, else its name. */
export const optionOf = (id: string) => (PRESSES[id] ? `${PRESSES[id]} press${PRESSES[id] > 1 ? 'es' : ''}` : labelOf(id))

/**
 * Everything a phone's browser can hear, by source (spec/RESEARCH-BUTTONS.md, the matrix): what the Buttons sheet and
 * the catalogue builder offer to bind. The volume keys are here for keyboards that have them: a phone's own never
 * reach a page.
 */
export const INPUT_OPTIONS: readonly { source: InputSource; ids: readonly string[] }[] = [
  { source: 'media', ids: ['media:playpause', 'media:nexttrack', 'media:previoustrack'] },
  {
    source: 'keys',
    ids: ['key:Enter', 'key:Space', 'key:Escape', 'key:Backspace', 'key:ArrowLeft', 'key:ArrowRight', 'key:ArrowUp', 'key:ArrowDown',
      'key:PageUp', 'key:PageDown', 'key:Home', 'key:End', 'key:F5', 'key:Period', 'key:KeyB', 'key:MediaPlayPause', 'key:MediaTrackNext',
      'key:MediaTrackPrevious'],
  },
  {
    source: 'pad',
    ids: [...Array.from({ length: 17 }, (_, i) => `pad:b${i}`), ...[0, 1, 2, 3].flatMap((i) => [`pad:a${i}-`, `pad:a${i}+`])],
  },
  { source: 'back', ids: ['back'] },
  { source: 'volume', ids: ['key:AudioVolumeUp', 'key:AudioVolumeDown'] },
]

// ---- controls: what an input can press ------------------------------------------------------------------------------

const PAD_CONTROLS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'view', 'menu', 'ls', 'rs', 'up', 'down', 'left', 'right', 'guide'] as const
/** The keys a host with a keyboard control takes as taps (PROTOCOL §3, the `keyboard` control's key row). */
export const KEY_TARGETS = ['key-Escape', 'key-Tab', 'key-ArrowLeft', 'key-ArrowUp', 'key-ArrowDown', 'key-ArrowRight', 'key-Backspace', 'key-Enter'] as const

/**
 * The controls a physical input may press on each controller (CATALOGUE §9.1: ControllerSpec.controls), keyed by
 * controller id. The gamepad's are PAD's buttons in the standard order. On any controller an input may also press a key
 * on the screen (KEY_TARGETS) where the screen takes typing.
 */
export const CONTROLS = {
  'face.drums': ['kick', 'snare', 'hat'],
  'face.keys': ['note1', 'note2', 'note3', 'note4', 'note5', 'note6', 'note7', 'note8', 'sustain', 'octaveup', 'octavedown'],
  'face.gamepad': PAD_CONTROLS,
  'face.wheel': PAD_CONTROLS,
  'face.wii': ['a', 'b', 'minus', 'home', 'plus'],
  'face.mouse': ['left', 'right', 'middle', 'wheel', 'minus', 'plus', 'home'],
  'face.trackpad': ['grab', 'level'],
  'face.hand': ['hold', 'recentre'],
  'face.keyboard': KEY_TARGETS,
} as const satisfies Record<string, readonly string[]>

const controlsOf = (controller: string): readonly string[] => (CONTROLS as Record<string, readonly string[] | undefined>)[controller] ?? []

/** The phone's own actions a binding may press on any controller. */
export const APP_ACTIONS = ['gyro', 'recentre', 'next', 'prev', 'keyboard'] as const
export type AppAction = (typeof APP_ACTIONS)[number]

/** Most bindings a profile carries. */
export const MAX_BUTTONS = 32
/** A tray button's id in a target (`tray:<id>`). */
const TRAY = /^tray:\S{1,40}$/
/** Any target's shape, whatever the controller (profile.schema.json); isTarget() also checks the controller's controls. */
export const BUTTON_TARGET = /^(none|tray:\S{1,40}|app:(gyro|recentre|next|prev|keyboard)|[a-z][a-z0-9]{0,15}|key-[A-Za-z]{1,16})$/

/** Whether `t` is something an input may press on `controller`: its control, a key on the screen, a tray button, the phone's own, or none. */
export function isTarget(controller: string, t: unknown): t is string {
  if (typeof t !== 'string') return false
  if (t === 'none' || TRAY.test(t)) return true
  if (t.startsWith('app:')) return (APP_ACTIONS as readonly string[]).includes(t.slice(4))
  return controlsOf(controller).includes(t) || (KEY_TARGETS as readonly string[]).includes(t)
}

const CONTROL_LABELS: Record<string, string> = {
  a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', view: 'View', menu: 'Menu', ls: 'LS', rs: 'RS',
  up: '↑', down: '↓', left: '←', right: '→', guide: 'Guide', minus: '−', plus: '+', home: '⌂',
  grab: 'Gyro', level: 'Level', hold: 'Hold', recentre: 'Recentre',
}
const MOUSE_LABELS: Record<string, string> = { left: 'Left', right: 'Right', middle: 'Middle', wheel: 'Wheel', minus: 'Zoom −', plus: 'Zoom +', home: '⌂' }
const APP_LABELS: Record<AppAction, string> = { gyro: 'Gyro', recentre: 'Recentre', next: 'Next controller', prev: 'Previous controller', keyboard: 'Keyboard' }

/** A target as a person reads it on `controller`: "A", "Left", "Zoom +", "Keyboard", or a tray button's label. */
export function targetLabel(controller: string, t: string, tray?: readonly { id: string; label: string }[]): string {
  if (t === 'none') return 'Nothing'
  if (t.startsWith('tray:')) return tray?.find((c) => c.id === t.slice(5))?.label ?? t.slice(5)
  if (t.startsWith('app:')) return APP_LABELS[t.slice(4) as AppAction] ?? t
  if (t.startsWith('key-')) return labelOf(`key:${t.slice(4)}`)
  if (controller === 'face.mouse' && MOUSE_LABELS[t]) return MOUSE_LABELS[t]
  return CONTROL_LABELS[t] ?? t
}

// ---- defaults -------------------------------------------------------------------------------------------------------

/**
 * The inputs that stand for the four hardware actions a host could bind before bindings (Layout.keys): primary is
 * volume up, Enter, Space or one headset press; secondary volume down, Esc or Backspace; next and previous the arrows,
 * Page Up and Down, or two and three headset presses. A pad's A, B and D-pad take the same rows.
 */
export const ACTION_INPUTS: Record<HardwareKey, readonly string[]> = {
  primary: ['key:AudioVolumeUp', 'key:Enter', 'key:NumpadEnter', 'key:Space', 'key:MediaPlayPause', 'media:playpause', 'pad:b0'],
  secondary: ['key:AudioVolumeDown', 'key:Escape', 'key:Backspace', 'pad:b1'],
  next: ['key:ArrowRight', 'key:PageDown', 'key:MediaTrackNext', 'media:nexttrack', 'pad:b15'],
  prev: ['key:ArrowLeft', 'key:PageUp', 'key:MediaTrackPrevious', 'media:previoustrack', 'pad:b14'],
}

/** The four actions pressing these targets, as input -> target; tap-only inputs skip a target that must be held. */
function fromActions(t: Partial<Record<HardwareKey, string>>, heldOnly: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [action, target] of Object.entries(t) as [HardwareKey, string][]) {
    for (const input of ACTION_INPUTS[action]) if (!(heldOnly.includes(target) && tapsOnly(input))) out[input] = target
  }
  return out
}

/** On the gamepad a pad's own buttons pass straight through: the standard mapping is already the controller's layout. */
const PAD_THROUGH: Record<string, string> = Object.fromEntries(PAD_CONTROLS.map((c, i) => [padButton(i, true), c]))
const GAMEPAD_KEYS = { ...fromActions({ primary: 'a', secondary: 'b', next: 'right', prev: 'left' }), 'key:ArrowUp': 'up', 'key:ArrowDown': 'down', ...PAD_THROUGH }

export type ControllerKey = keyof typeof CONTROLS

/**
 * What each physical input presses before anyone changes anything: today's behaviour, as data. `back` is bound to
 * nothing anywhere: catching it is an opt-in.
 */
export const DEFAULT_BUTTONS: Record<ControllerKey, Readonly<Record<string, string>>> = {
  'face.drums': fromActions({ primary: 'kick', secondary: 'snare', next: 'hat' }),
  'face.keys': fromActions({ primary: 'note1', secondary: 'sustain', next: 'octaveup', prev: 'octavedown' }, ['sustain']),
  'face.gamepad': GAMEPAD_KEYS,
  // The steering wheel: the volume keys are the pedals, held.
  'face.wheel': { ...GAMEPAD_KEYS, 'key:AudioVolumeUp': 'rt', 'key:AudioVolumeDown': 'lt' },
  'face.wii': fromActions({ primary: 'a', secondary: 'b', next: 'plus', prev: 'minus' }),
  'face.mouse': fromActions({ primary: 'left', secondary: 'wheel', next: 'plus', prev: 'minus' }),
  'face.trackpad': fromActions({ primary: 'grab', secondary: 'level' }),
  // The 3D hand: held, a button is the deadman (a thumb on the pad); a headset press can't hold, so it isn't one.
  'face.hand': fromActions({ primary: 'hold', secondary: 'recentre' }, ['hold']),
  'face.keyboard': {},
}

// ---- smart use: recognising a device from what it sends -------------------------------------------------------------

/** The kinds of device the phone recognises: each gets its own smart defaults on each controller. */
export const DEVICE_KINDS = ['clicker', 'selfie', 'pad', 'headset', 'keyboard'] as const
export type DeviceKind = (typeof DEVICE_KINDS)[number]
export const isDeviceKind = (x: unknown): x is DeviceKind => typeof x === 'string' && (DEVICE_KINDS as readonly string[]).includes(x)

/** What a presentation clicker sends: next and previous (the arrows, Page Up and Down), and start, stop and blank. */
const CLICKER_KEYS = ['key:ArrowRight', 'key:ArrowLeft', 'key:ArrowUp', 'key:ArrowDown', 'key:PageDown', 'key:PageUp', 'key:F5', 'key:Escape', 'key:Period', 'key:KeyB']
const CLICKER_NAV = ['key:ArrowRight', 'key:ArrowLeft', 'key:ArrowUp', 'key:ArrowDown', 'key:PageDown', 'key:PageUp']
/** What a selfie remote sends: Enter from its Android button, volume up from its iOS one. */
const SELFIE_KEYS = ['key:Enter', 'key:NumpadEnter', 'key:AudioVolumeUp']

/**
 * The kind of device behind what one source has sent this session (every input from it so far): media actions are a
 * headset; a pad with the standard mapping is a pad; keys that are only arrows or Page Up and Down (with a clicker's
 * start, stop and blank) are a presentation clicker; a lone Enter or volume up is a selfie remote; any other key is a
 * keyboard. Null for what the phone can't use without setup: a pad the browser can't map, or Back.
 */
export function inferKind(inputs: readonly string[]): DeviceKind | null {
  if (!inputs.length) return null
  if (inputs.some((id) => id.startsWith('media:'))) return 'headset'
  if (inputs.some((id) => id.startsWith('pad:'))) return inputs.some((id) => id.startsWith('pad:raw:')) ? null : 'pad'
  const keys = inputs.filter((id) => id.startsWith('key:'))
  if (!keys.length) return null
  if (keys.every((id) => SELFIE_KEYS.includes(id))) return 'selfie'
  if (keys.every((id) => CLICKER_KEYS.includes(id)) && keys.some((id) => CLICKER_NAV.includes(id))) return 'clicker'
  return 'keyboard'
}

const PAD_EXTRAS = { 'pad:b9': 'app:next', 'pad:b8': 'app:prev' }
/** Next and previous as the screen's arrow keys, where the screen takes typing: a presentation moves on. */
const CLICKER_TO_KEYS = {
  'key:PageDown': 'key-ArrowRight', 'key:ArrowRight': 'key-ArrowRight', 'key:ArrowDown': 'key-ArrowRight',
  'key:PageUp': 'key-ArrowLeft', 'key:ArrowLeft': 'key-ArrowLeft', 'key:ArrowUp': 'key-ArrowLeft', 'key:Escape': 'key-Escape',
}

/**
 * The smart defaults for a kind of device on each controller: what makes it useful the moment it's recognised, on top of
 * the controller's defaults (which already give every kind's main buttons their jobs). Only what differs.
 *  - A clicker moves a presentation on: next and previous press the screen's arrow keys where it takes typing (a PC
 *    through ob.Pal Link), else the controller's own next and previous stand; its start key presses the primary control
 *    and its blank key the secondary.
 *  - A pad gets its shoulders and face buttons on the pointer controllers, and Menu and View pick the next or previous
 *    controller (the gamepad keeps them: they pass through).
 *  - A selfie remote, a headset and a keyboard need nothing beyond the defaults: their buttons already have jobs.
 */
export const SMART_BUTTONS: Record<DeviceKind, Partial<Record<ControllerKey, Readonly<Record<string, string>>>>> = {
  clicker: {
    'face.wii': { ...CLICKER_TO_KEYS, 'key:F5': 'a', 'key:Period': 'b', 'key:KeyB': 'b' },
    'face.mouse': { ...CLICKER_TO_KEYS, 'key:F5': 'left', 'key:Period': 'wheel', 'key:KeyB': 'wheel' },
    'face.trackpad': { ...CLICKER_TO_KEYS, 'key:F5': 'grab', 'key:Period': 'level', 'key:KeyB': 'level' },
    'face.hand': { ...CLICKER_TO_KEYS, 'key:Period': 'recentre', 'key:KeyB': 'recentre' },
    'face.gamepad': { 'key:F5': 'a', 'key:Period': 'b', 'key:KeyB': 'b' },
    'face.wheel': { 'key:F5': 'a', 'key:Period': 'b', 'key:KeyB': 'b' },
  },
  pad: {
    'face.wii': { 'pad:b4': 'minus', 'pad:b5': 'plus', 'pad:b2': 'home', ...PAD_EXTRAS },
    'face.mouse': { 'pad:b4': 'minus', 'pad:b5': 'plus', 'pad:b2': 'middle', 'pad:b3': 'right', ...PAD_EXTRAS },
    'face.trackpad': { 'pad:b2': 'app:recentre', ...PAD_EXTRAS },
    'face.hand': { 'pad:b2': 'recentre', ...PAD_EXTRAS },
  },
  selfie: {},
  headset: {},
  keyboard: {},
}

/** A kind's smart defaults on a controller (empty where it needs none). */
export const smartButtons = (kind: DeviceKind, controller: string): Readonly<Record<string, string>> =>
  (SMART_BUTTONS[kind] as Record<string, Readonly<Record<string, string>> | undefined>)[controller] ?? {}

// ---- layers ---------------------------------------------------------------------------------------------------------

export type Bindings = Readonly<Record<string, string>>

/** Controllers where a pad's buttons are the controller's own, so a host's `keys` don't apply (they never did). */
const GAMEPADS = ['face.gamepad', 'face.wheel']

/** What the screen offers that a binding may press: its tray buttons, and whether it takes typing (a keyboard control). */
export interface ScreenOffer { tray: readonly string[]; typing: boolean }

/** A layout's offer (ScreenOffer): the ids of its tray buttons, and whether it has a keyboard control. */
export const offerOf = (layout: Pick<Layout, 'tray'>): ScreenOffer => ({
  tray: layout.tray.filter((c) => (c.type ?? 'button') === 'button').map((c) => c.id),
  typing: layout.tray.some((c) => c.type === 'keyboard'),
})

/**
 * The host's suggestion for `controller` (Layout.buttons, and Layout.keys read as it): `keys` binds the four actions'
 * inputs to tray buttons on every controller but the gamepad's, as before; `buttons` binds any input. Tray buttons the
 * layout doesn't have are left to resolveButtons(), which skips them.
 */
export function hostButtons(layout: Pick<Layout, 'keys' | 'buttons'>, controller: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (layout.keys && typeof layout.keys === 'object' && !GAMEPADS.includes(controller)) {
    for (const [action, id] of Object.entries(layout.keys) as [HardwareKey, unknown][]) {
      if (typeof id === 'string' && ACTION_INPUTS[action]) for (const input of ACTION_INPUTS[action]) out[input] = `tray:${id}`
    }
  }
  if (layout.buttons && typeof layout.buttons === 'object') {
    for (const [input, t] of Object.entries(layout.buttons)) if (isInputId(input) && isTarget(controller, t)) out[input] = t
  }
  return out
}

/**
 * The bindings in effect on `controller`: its defaults, then each layer in turn, each listing only what it changes. The
 * phone's layers, in order: the smart defaults of the kinds of device it has recognised, the host's suggestion, the
 * profile's, and the person's own, which always win. A target the controller can't use is skipped, and so, when
 * `offer` says what the screen has, is a tray button it hasn't got or a key where it doesn't take typing: the layer
 * below stands. `none` takes an input away. Returns input id -> target, without the `none`s.
 */
export function resolveButtons(controller: string, layers: readonly (Bindings | undefined)[], offer?: ScreenOffer): Record<string, string> {
  const out: Record<string, string> = { ...((DEFAULT_BUTTONS as Record<string, Bindings | undefined>)[controller] ?? {}) }
  const usable = (t: string) => {
    if (!isTarget(controller, t)) return false
    if (!offer) return true
    if (t.startsWith('tray:')) return offer.tray.includes(t.slice(5))
    if (t.startsWith('key-') && controller !== 'face.keyboard') return offer.typing
    return true
  }
  for (const layer of layers) {
    if (!layer) continue
    for (const [input, t] of Object.entries(layer)) if (isInputId(input) && usable(t)) out[input] = t
  }
  for (const [input, t] of Object.entries(out)) if (t === 'none') delete out[input]
  return out
}

/** The inputs bound to `target`, in the order they were bound. */
export const inputsFor = (bindings: Bindings, target: string) => Object.keys(bindings).filter((input) => bindings[input] === target)

/** "PgDn = → · PgUp = ←": what these inputs press now, for a notice; the ones bound to nothing are left out. */
export function describeBindings(controller: string, inputs: readonly string[], bindings: Bindings, tray?: readonly { id: string; label: string }[], max = 3): string {
  const seen = new Set<string>()
  return inputs.filter((id) => bindings[id] && !seen.has(badgeOf(id)) && seen.add(badgeOf(id))).slice(0, max)
    .map((id) => `${badgeOf(id)} = ${targetLabel(controller, bindings[id], tray)}`).join(' · ')
}

/**
 * Check a profile's `buttons` for `controller` (checkProfile): an object of at most MAX_BUTTONS input ids, each bound
 * to something the controller can press. Returns the bindings, or what's wrong.
 */
export function checkButtons(controller: string, x: unknown): { buttons: Record<string, string> | null; errors: string[] } {
  const errors: string[] = []
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { buttons: null, errors: ['buttons: an object of input ids and what each presses'] }
  const entries = Object.entries(x as Record<string, unknown>)
  if (entries.length > MAX_BUTTONS) errors.push(`buttons: at most ${MAX_BUTTONS}`)
  for (const [input, t] of entries) {
    if (!isInputId(input)) errors.push(`buttons: "${input}" isn't an input id (key:<code>, media:<action>, pad:b<i>, back)`)
    else if (!isTarget(controller, t)) errors.push(`buttons.${input}: one of ${[...controlsOf(controller), 'key-<code>', 'tray:<id>', ...APP_ACTIONS.map((a) => `app:${a}`), 'none'].join(', ')}`)
  }
  return errors.length ? { buttons: null, errors } : { buttons: Object.fromEntries(entries) as Record<string, string>, errors }
}
