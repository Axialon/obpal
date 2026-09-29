/**
 * The control catalogue (spec/CATALOGUE.md): utilities, the routes a motion utility can take, the built-in profiles,
 * and the controllers built from them. Data only; the phone offers what a host's layout allows and hosts finish each
 * route.
 */
import { checkButtons, CONTROLS, MAX_BUTTONS } from './buttons'
import type { Layout, TrayControl } from './messages'
import type { Response } from './response'
import { Mode, type ModeId } from './state'

export const Utility = {
  pad: 'pad',
  aim: 'motion.aim',
  steer: 'motion.steer',
  point: 'motion.point',
  track: 'motion.track',
  cameraHand: 'camera.hand',
  trackpad: 'touch.trackpad',
  hold: 'motion.hold',
  tilt: 'motion.tilt',
  drums: 'music.hit',
  keys: 'music.note',
} as const
export type UtilityId = (typeof Utility)[keyof typeof Utility]

/** The Motion and Pointer utilities a gamepad surface offers as chips, in display order. */
export const MOTION_UTILITIES = [Utility.aim, Utility.steer, Utility.point] as const
export type MotionUtility = (typeof MOTION_UTILITIES)[number]

export type Route = 'stick.left' | 'stick.right' | 'stick.fly' | 'stick.wheel' | 'mouse' | 'pointer'

/** Routes each motion utility may take (CATALOGUE §2), the default first. */
export const ROUTES: Record<MotionUtility, readonly Route[]> = {
  'motion.aim': ['stick.right', 'stick.left', 'mouse'],
  'motion.steer': ['stick.wheel', 'stick.fly', 'stick.left', 'stick.right'],
  'motion.point': ['pointer'],
}

export interface UtilitySettings extends Response {
  route: Route
  /** Point only: near a screen edge the right stick deflects toward it (CATALOGUE §4). */
  edgeTurn: boolean
}

export interface Profile {
  id: ProfileId
  name: string
  /** What it is for, one line. */
  for: string
  /** Utilities the profile switches on when it applies. */
  on: readonly MotionUtility[]
  aim: UtilitySettings
  steer: UtilitySettings
  point: UtilitySettings
  /** The controller the profile tunes (§9.1); absent: `face.gamepad`, as for every built-in. */
  controller?: ControllerId
  /**
   * Physical inputs bound to that controller's controls (CATALOGUE §3, `buttons`): input id -> a control, a key on the
   * screen (`key-<code>`), `tray:<id>`, `app:<action>` or `none`. Only what differs from the controller's defaults.
   */
  buttons?: Readonly<Record<string, string>>
}

export const PROFILE_IDS = ['default', 'flight', 'driving', 'shooter', 'pointer'] as const
export type ProfileId = (typeof PROFILE_IDS)[number]
export const isProfileId = (x: unknown): x is ProfileId => typeof x === 'string' && (PROFILE_IDS as readonly string[]).includes(x)

const u = (route: Route, over: Partial<UtilitySettings> = {}): UtilitySettings =>
  ({ route, gain: 1, curve: 1, deadzone: 0.2, invertY: false, edgeTurn: false, ...over })

/**
 * The built-in profiles (CATALOGUE §3). Flight and Driving switch Steer on as they apply, so tilting the phone flies or
 * steers at once; Pointer switches Point on.
 */
export const PROFILES: Record<ProfileId, Profile> = {
  default: {
    id: 'default', name: 'Default', for: 'Most gamepad games', on: [],
    aim: u('stick.right'), steer: u('stick.wheel'), point: u('pointer'),
  },
  flight: {
    id: 'flight', name: 'Flight', for: 'Flight and space games: tilt the phone like a yoke', on: ['motion.steer'],
    aim: u('stick.right'), steer: u('stick.fly'), point: u('pointer'),
  },
  driving: {
    id: 'driving', name: 'Driving', for: 'Racing: tilt to steer, triggers for throttle and brake', on: ['motion.steer'],
    aim: u('stick.right'), steer: u('stick.wheel'), point: u('pointer'),
  },
  shooter: {
    id: 'shooter', name: 'Shooter', for: 'First-person shooters: gyro mouse under pointer lock', on: [],
    aim: u('mouse'), steer: u('stick.wheel'), point: u('pointer', { edgeTurn: true }),
  },
  pointer: {
    id: 'pointer', name: 'Pointer', for: 'Menus, point-and-click and Wii-style games', on: ['motion.point'],
    aim: u('stick.right'), steer: u('stick.wheel'), point: u('pointer'),
  },
}

/** Settings a user changed on top of a built-in profile, per utility. */
export type ProfileOverrides = Partial<Record<'aim' | 'steer' | 'point', Partial<UtilitySettings>>>

export const utilityKey = (id: MotionUtility): 'aim' | 'steer' | 'point' => (id === 'motion.aim' ? 'aim' : id === 'motion.steer' ? 'steer' : 'point')

/** A built-in profile with a user's overrides applied; unknown routes fall back to the built-in one. */
export function resolveProfile(id: ProfileId, over: ProfileOverrides = {}): Profile {
  const base = PROFILES[id]
  const merge = (key: 'aim' | 'steer' | 'point', utility: MotionUtility): UtilitySettings => {
    const o = over[key] ?? {}
    const routes = ROUTES[utility]
    const route = o.route && routes.includes(o.route) ? o.route : base[key].route
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
    return {
      route,
      gain: num(o.gain, 0.25, 4, base[key].gain),
      curve: num(o.curve, 0.5, 3, base[key].curve),
      deadzone: num(o.deadzone, 0, 0.5, base[key].deadzone),
      invertY: typeof o.invertY === 'boolean' ? o.invertY : base[key].invertY,
      edgeTurn: typeof o.edgeTurn === 'boolean' ? o.edgeTurn : base[key].edgeTurn,
    }
  }
  return { ...base, aim: merge('aim', Utility.aim), steer: merge('steer', Utility.steer), point: merge('point', Utility.point) }
}

/** Which motion utilities a layout offers: its `utilities` list filtered to motion ones, or all of them. */
export function offeredMotion(utilities: readonly string[] | undefined): MotionUtility[] {
  if (!utilities) return [...MOTION_UTILITIES]
  return MOTION_UTILITIES.filter((m) => utilities.includes(m))
}

/** A profile anyone can write (the catalogue's builder, the SDK, an AI agent): a built-in's shape with its own id. */
export type ProfileSpec = Omit<Profile, 'id'> & { id: string }

/** The ranges resolveProfile() keeps settings in, and the id a new profile may take. */
export const PROFILE_LIMITS = { gain: [0.25, 4], curve: [0.5, 3], deadzone: [0, 0.5], id: /^[a-z][a-z0-9-]{1,31}$/, name: 40, for: 120, buttons: MAX_BUTTONS } as const

/**
 * Check a proposed profile (spec/CATALOGUE.md §3; public/profile.schema.json says the same): every field present and
 * in range, routes the utility can take, an id that isn't a built-in's, and, if it has them, a known controller and
 * buttons that controller can press. Returns the profile, or what's wrong.
 */
export function checkProfile(x: unknown): { profile: ProfileSpec | null; errors: string[] } {
  const errors: string[] = []
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id : ''
  if (!PROFILE_LIMITS.id.test(id)) errors.push('id: 2 to 32 characters, lowercase letters, digits and dashes, starting with a letter')
  else if (isProfileId(id)) errors.push(`id: "${id}" is a built-in profile`)
  for (const k of ['name', 'for'] as const) {
    const v = o[k]
    if (typeof v !== 'string' || !v.trim()) errors.push(`${k}: required`)
    else if (v.length > PROFILE_LIMITS[k]) errors.push(`${k}: at most ${PROFILE_LIMITS[k]} characters`)
  }
  const on = Array.isArray(o.on) ? o.on : []
  if (!Array.isArray(o.on)) errors.push('on: a list of utilities (it may be empty)')
  for (const u of on) if (!(MOTION_UTILITIES as readonly unknown[]).includes(u)) errors.push(`on: "${String(u)}" isn't one of ${MOTION_UTILITIES.join(', ')}`)
  const settings = {} as Record<'aim' | 'steer' | 'point', UtilitySettings>
  for (const utility of MOTION_UTILITIES) {
    const key = utilityKey(utility)
    const s = (o[key] && typeof o[key] === 'object' ? o[key] : null) as Record<string, unknown> | null
    if (!s) { errors.push(`${key}: required`); continue }
    const routes = ROUTES[utility] as readonly unknown[]
    if (!routes.includes(s.route)) errors.push(`${key}.route: one of ${routes.join(', ')}`)
    for (const n of ['gain', 'curve', 'deadzone'] as const) {
      const [lo, hi] = PROFILE_LIMITS[n]
      if (typeof s[n] !== 'number' || !Number.isFinite(s[n]) || (s[n] as number) < lo || (s[n] as number) > hi) errors.push(`${key}.${n}: a number from ${lo} to ${hi}`)
    }
    for (const b of ['invertY', 'edgeTurn'] as const) if (typeof s[b] !== 'boolean') errors.push(`${key}.${b}: true or false`)
    settings[key] = { route: s.route as Route, gain: s.gain as number, curve: s.curve as number, deadzone: s.deadzone as number, invertY: !!s.invertY, edgeTurn: !!s.edgeTurn }
  }
  let controller: ControllerId | undefined
  if (o.controller !== undefined) {
    if (isControllerId(o.controller)) controller = o.controller
    else errors.push(`controller: one of ${CONTROLLER_IDS.join(', ')}`)
  }
  let buttons: Record<string, string> | undefined
  if (o.buttons !== undefined) {
    const b = checkButtons(controller ?? Controller.gamepad, o.buttons)
    errors.push(...b.errors)
    buttons = b.buttons ?? undefined
  }
  if (errors.length) return { profile: null, errors }
  return {
    profile: { id, name: (o.name as string).trim(), for: (o.for as string).trim(), on: on as MotionUtility[], ...settings, ...(controller ? { controller } : {}), ...(buttons ? { buttons } : {}) },
    errors,
  }
}

// ---- controllers (CATALOGUE §9) -------------------------------------------------------------------------------------

/**
 * The controllers a person picks from on the device (CATALOGUE §9.1): faces drawn on its screen, each built from
 * utilities. A host names the ones it suggests in `layout.controllers`, the first to open; a device says which one it
 * uses in `mode{c}`. The ids are stable, so pages (the embed's `modes`) and profiles can name them.
 */
export const Controller = {
  gamepad: 'face.gamepad',
  wheel: 'face.wheel',
  wii: 'face.wii',
  mouse: 'face.mouse',
  trackpad: 'face.trackpad',
  hand: 'face.hand',
  keyboard: 'face.keyboard',
  drums: 'face.drums',
  keys: 'face.keys',
} as const
export type ControllerId = (typeof Controller)[keyof typeof Controller]

export interface ControllerSpec {
  id: ControllerId
  name: string
  /** Where the picker groups it (CATALOGUE §9.3). */
  category: 'Controller' | 'Pointer' | 'Touch' | '3D' | 'Keys' | 'Music'
  /** What it is for, one line. */
  for: string
  /** The utilities it is built from (§1); the keyboard types (`text`) instead. */
  utilities: readonly UtilityId[]
  /** The modes it sends in (`mode{m}`), the one it opens in first; none for the keyboard, which types beside any of them. */
  modes: readonly ModeId[]
  /** What a physical input may press on it (CATALOGUE §3, `buttons`): the ids a binding names. */
  controls: readonly string[]
}

/** The controllers, in the picker's order: Controller, Pointer, Touch, 3D, Keys (CATALOGUE §9.1). */
export const CONTROLLERS: Record<ControllerId, ControllerSpec> = {
  'face.gamepad': {
    id: 'face.gamepad', name: 'Gamepad', category: 'Controller', for: 'Sticks, D-pad, face buttons and triggers, with gyro aim, tilt steering and pointing',
    utilities: [Utility.pad, Utility.aim, Utility.steer, Utility.point], modes: [Mode.gamepad], controls: CONTROLS['face.gamepad'],
  },
  'face.wheel': {
    id: 'face.wheel', name: 'Steering wheel', category: 'Controller', for: 'Tilt to steer, the triggers as pedals: the gamepad with the Driving profile',
    utilities: [Utility.pad, Utility.steer], modes: [Mode.gamepad], controls: CONTROLS['face.wheel'],
  },
  'face.wii': {
    id: 'face.wii', name: 'Wii remote', category: 'Pointer', for: 'Point at the screen: A selects, hold B to grab, − and + zoom',
    utilities: [Utility.point], modes: [Mode.point], controls: CONTROLS['face.wii'],
  },
  'face.mouse': {
    id: 'face.mouse', name: 'Air mouse', category: 'Pointer', for: 'Point at the screen: Left and Right click, and a wheel scrolls',
    utilities: [Utility.point], modes: [Mode.point], controls: CONTROLS['face.mouse'],
  },
  'face.trackpad': {
    id: 'face.trackpad', name: 'Trackpad', category: 'Touch', for: 'Drag, pan, pinch and twist; with the gyro on, turn things 1:1 or tilt them',
    utilities: [Utility.trackpad, Utility.hold, Utility.tilt], modes: [Mode.tilt, Mode.hold], controls: CONTROLS['face.trackpad'],
  },
  'face.hand': {
    id: 'face.hand', name: '3D hand', category: '3D', for: 'Hold the pad and move the phone: what you hold moves with it',
    utilities: [Utility.track], modes: [Mode.track], controls: CONTROLS['face.hand'],
  },
  'face.keyboard': {
    id: 'face.keyboard', name: 'Keyboard', category: 'Keys', for: 'The phone’s own keyboard types on the screen, with Esc, Tab, the arrows and Enter',
    utilities: [], modes: [], controls: CONTROLS['face.keyboard'],
  },
  'face.drums': {
    id: 'face.drums', name: 'Drums', category: 'Music', for: 'Velocity pads and held strike gestures',
    utilities: [Utility.drums, Utility.tilt], modes: [Mode.pad], controls: CONTROLS['face.drums'],
  },
  'face.keys': {
    id: 'face.keys', name: 'Tone keys', category: 'Music', for: 'Scale-locked notes, tilt bend, sustain and an air instrument',
    utilities: [Utility.keys, Utility.tilt], modes: [Mode.pad], controls: CONTROLS['face.keys'],
  },
}
export const CONTROLLER_IDS = Object.keys(CONTROLLERS) as ControllerId[]
export const isControllerId = (x: unknown): x is ControllerId => typeof x === 'string' && Object.prototype.hasOwnProperty.call(CONTROLLERS, x)

/**
 * The shape of any controller id on the wire: a kind, a dot and a name (`face.wii`, `bridge.gamepad`). Devices and hosts
 * pass on well-formed ids they don't know, since a newer one may name a controller this version hasn't met.
 */
export const CONTROLLER_ID = /^[a-z]{2,12}\.[a-z0-9-]{1,32}$/

/** The tray control that opens the device's keyboard: `face.keyboard` for devices that predate controllers. */
export const KEYBOARD_CONTROL: TrayControl = { id: 'keyboard', label: 'Keyboard', type: 'keyboard', icon: 'keyboard' }

/** Whether controller `a` is listed, and ahead of `b` if both are. */
const ahead = (ids: readonly string[], a: ControllerId, b: ControllerId) => {
  const i = ids.indexOf(a)
  const j = ids.indexOf(b)
  return i >= 0 && (j < 0 || i < j)
}

/**
 * A layout as every device reads it (CATALOGUE §9.2): what its `controllers` mean in the fields devices knew before
 * them. Absent `modes` become the modes of the controllers, in order; `face.mouse` ahead of `face.wii` makes the Point
 * face a mouse; `face.keyboard` adds the keyboard to the tray; `face.wheel` ahead of `face.gamepad` suggests the
 * Driving profile. Whatever the layout sets itself is kept, and a layout that names no controllers comes back as it is.
 */
export function withControllers<L extends Layout>(layout: L): L {
  const ids = Array.isArray(layout.controllers) ? layout.controllers.filter(isControllerId) : []
  if (!ids.length) return layout
  const out: L = { ...layout }
  if (!out.modes) out.modes = [...new Set(ids.flatMap((c) => CONTROLLERS[c].modes))]
  if (!out.point && ahead(ids, Controller.mouse, Controller.wii)) out.point = 'mouse'
  if (!out.profile && ahead(ids, Controller.wheel, Controller.gamepad)) out.profile = 'driving'
  if (ids.includes(Controller.keyboard) && !out.tray.some((c) => c.type === 'keyboard')) out.tray = [...out.tray, KEYBOARD_CONTROL]
  return out
}

/** The controller a mode stands for on a host with this layout: what a device that says only `mode{m}` (no `c`) uses. */
export function controllerOf(m: ModeId, layout: Pick<Layout, 'point'> = {}): ControllerId | null {
  switch (m) {
    case Mode.gamepad: return Controller.gamepad
    case Mode.point: return layout.point === 'mouse' ? Controller.mouse : Controller.wii
    case Mode.track: return Controller.hand
    case Mode.hold: case Mode.tilt: case Mode.orbit: case Mode.pad: return Controller.trackpad
    default: return null
  }
}

/**
 * The controllers a layout offers, in its order (CATALOGUE §9.2): the known ones it names in `controllers`, else, from a
 * host that names none (every host before them), the faces of its modes, and the keyboard where its tray has one. No
 * modes at all is what devices show without them: the trackpad and the Wii remote.
 */
export function layoutControllers(layout: Pick<Layout, 'modes' | 'controllers' | 'point' | 'tray'>): ControllerId[] {
  const named = Array.isArray(layout.controllers) ? layout.controllers.filter(isControllerId) : []
  if (named.length) return [...new Set(named)]
  const out = new Set<ControllerId>()
  for (const m of layout.modes ?? [Mode.hold, Mode.point]) { const c = controllerOf(m, layout); if (c) out.add(c) }
  if (layout.tray?.some((c) => c.type === 'keyboard')) out.add(Controller.keyboard)
  return [...out]
}

/**
 * What a device's `mode{m, c?, p?}` says it uses (CATALOGUE §9.4): its controller (`c`, else the one its mode stands for
 * on this host) and its profile (`p`). Each is kept only when well formed; a well-formed id this version doesn't know
 * passes, since a newer device may name a controller or a community profile.
 */
export function readMode(msg: { m?: unknown; c?: unknown; p?: unknown }, layout: Pick<Layout, 'point'> = {}): { controller?: string; profile?: string } {
  const said = typeof msg.c === 'string' && CONTROLLER_ID.test(msg.c) ? msg.c : undefined
  const controller = said ?? (typeof msg.m === 'number' ? controllerOf(msg.m as ModeId, layout) ?? undefined : undefined)
  const profile = typeof msg.p === 'string' && PROFILE_LIMITS.id.test(msg.p) ? msg.p : undefined
  return { ...(controller ? { controller } : {}), ...(profile ? { profile } : {}) }
}
