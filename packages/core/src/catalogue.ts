/**
 * The control catalogue (spec/CATALOGUE.md): utilities, the routes a motion utility can take, and the built-in
 * profiles. Data only; the phone offers what a host's layout allows and hosts finish each route.
 */
import type { Response } from './response'

export const Utility = {
  pad: 'pad',
  aim: 'motion.aim',
  steer: 'motion.steer',
  point: 'motion.point',
  trackpad: 'touch.trackpad',
  hold: 'motion.hold',
  tilt: 'motion.tilt',
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
}

export const PROFILE_IDS = ['default', 'flight', 'driving', 'shooter', 'pointer'] as const
export type ProfileId = (typeof PROFILE_IDS)[number]
export const isProfileId = (x: unknown): x is ProfileId => typeof x === 'string' && (PROFILE_IDS as readonly string[]).includes(x)

const u = (route: Route, over: Partial<UtilitySettings> = {}): UtilitySettings =>
  ({ route, gain: 1, curve: 1, deadzone: 0.2, invertY: false, edgeTurn: false, ...over })

/** The built-in profiles (CATALOGUE §3). */
export const PROFILES: Record<ProfileId, Profile> = {
  default: {
    id: 'default', name: 'Default', for: 'Most gamepad games', on: [],
    aim: u('stick.right'), steer: u('stick.wheel'), point: u('pointer'),
  },
  flight: {
    id: 'flight', name: 'Flight', for: 'Flight and space games: tilt the phone like a yoke', on: [],
    aim: u('stick.right'), steer: u('stick.fly'), point: u('pointer'),
  },
  driving: {
    id: 'driving', name: 'Driving', for: 'Racing: tilt to steer, triggers for throttle and brake', on: [],
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
