/**
 * Which controllers suit the screen this phone is connected to (CATALOGUE §9.2), as the phone's controller bar and
 * catalogue show them: each controller's fit for that screen, the one it suits best, and why the ones it doesn't take
 * are out. Pure: the screen's layout and what this phone can do go in, ratings come out, so node tests it.
 *
 * The fit, from what the screen sent:
 *   3  best   the screen's first suggestion (`layout.controllers[0]`), or, from a screen that names none, the controller
 *             its suggested profile tunes (Driving is the steering wheel; the other profiles tune the gamepad), else
 *             the controller of the first mode it lists
 *   2  suits  the screen names it (`layout.controllers`), or it is a face of the modes it lists (a screen from before
 *             controllers: `layoutControllers`)
 *   1  works  the screen takes everything it sends, but doesn't name it (the air mouse where the screen's pointing
 *             face is the Wii remote, the steering wheel in any gamepad game)
 *   0  no     the screen doesn't take what it sends: dimmed, and a long press says why
 */
import { Controller, CONTROLLER_IDS, CONTROLLERS, isControllerId, isProfileId, layoutControllers, Mode, Utility, type ControllerId, type Layout, type UtilityId } from '@obpal/core'

export type Fit = 0 | 1 | 2 | 3

export interface Rating {
  id: ControllerId
  fit: Fit
  /** The screen's best: its first suggestion (or its first mode's controller). At most one controller is. */
  best: boolean
  /** It steers with the phone's motion sensors, which this phone hasn't got (or hasn't allowed yet). */
  needsMotion: boolean
  /** Why the screen doesn't take it (fit 0), in one line; empty otherwise. */
  why: string
}

/** What the ratings read from a layout. */
export type RatedLayout = Pick<Layout, 'modes' | 'controllers' | 'utilities' | 'point' | 'tray' | 'profile' | 'universal'>

/**
 * The face a controller is drawn on: the phone's panels, named as the old mode tabs were (`rotate` is the trackpad's,
 * `track` the 3D hand's), since pages, tests and physical buttons address them by these names. Two controllers share a
 * face where one is a variant of the other: the Wii remote and the air mouse point, the steering wheel is the gamepad
 * with the Driving profile. The keyboard has no face: it types beside any of them.
 */
export type Face = 'rotate' | 'point' | 'track' | 'gamepad' | 'drums' | 'keys'
export const FACE_OF: Record<ControllerId, Face | null> = {
  'face.gamepad': 'gamepad', 'face.wheel': 'gamepad', 'face.wii': 'point', 'face.mouse': 'point', 'face.trackpad': 'rotate',
  'face.hand': 'track', 'face.keyboard': null, 'face.drums': 'drums', 'face.keys': 'keys',
}

/** Short names, for the controller bar where a name has to fit beside its icon. */
export const SHORT_NAME: Record<ControllerId, string> = {
  'face.gamepad': 'Gamepad', 'face.wheel': 'Wheel', 'face.wii': 'Wii', 'face.mouse': 'Mouse', 'face.trackpad': 'Trackpad',
  'face.hand': '3D hand', 'face.keyboard': 'Keyboard', 'face.drums': 'Drums', 'face.keys': 'Keys',
}

/** The icon each controller is drawn with (src/ui/icons.ts). */
export const CONTROLLER_ICON: Record<ControllerId, string> = {
  'face.gamepad': 'gamepad', 'face.wheel': 'wheel', 'face.wii': 'remote', 'face.mouse': 'mouse', 'face.trackpad': 'trackpad',
  'face.hand': 'hand', 'face.keyboard': 'keyboard', 'face.drums': 'drum', 'face.keys': 'piano',
}

/**
 * What a screen must take for each controller to work there. `all`: every one of these utilities; `any`: at least one
 * (the trackpad works as touch, 1:1 or tilt). The gamepad's motion chips are extras it offers only where they're taken.
 */
const NEEDS: Record<ControllerId, { all?: UtilityId[]; any?: UtilityId[] }> = {
  'face.gamepad': { all: [Utility.pad] },
  'face.wheel': { all: [Utility.pad, Utility.steer] },
  'face.wii': { all: [Utility.point] },
  'face.mouse': { all: [Utility.point] },
  'face.trackpad': { any: [Utility.trackpad, Utility.hold, Utility.tilt] },
  'face.hand': { all: [Utility.track] },
  'face.keyboard': {},
  'face.drums': { all: [Utility.drums] },
  'face.keys': { all: [Utility.keys] },
}

/** The controllers that steer with motion and do nothing useful without it (the 3D hand can glow for a camera instead). */
const MOTION = new Set<ControllerId>([Controller.wii, Controller.mouse, Controller.wheel])

/** Why a screen that doesn't take a controller doesn't, in one line. */
function whyNot(id: ControllerId, host: string, steerOnly: boolean): string {
  switch (id) {
    case 'face.gamepad': return `${host} doesn’t take a gamepad`
    case 'face.wheel': return steerOnly ? `${host} doesn’t take tilt steering` : `${host} doesn’t take a gamepad`
    case 'face.wii': case 'face.mouse': return `${host} doesn’t take pointing`
    case 'face.trackpad': return `${host} doesn’t take touch or tilt`
    case 'face.hand': return `${host} doesn’t take 3D motion`
    case 'face.keyboard': return `${host} doesn’t take typing`
    case 'face.drums': return 'Drums play on a music screen'
    case 'face.keys': return 'Tone keys play on a music screen'
  }
}

/**
 * The controllers a screen puts forward, in its order: the ones it names, else the faces of the modes it lists (with a
 * malformed field read as absent).
 */
function putForward(layout: RatedLayout): ControllerId[] {
  const named = Array.isArray(layout.controllers) ? [...new Set(layout.controllers.filter(isControllerId))] : []
  if (named.length) return named
  return layoutControllers({
    modes: Array.isArray(layout.modes) ? layout.modes : undefined,
    point: layout.point,
    tray: Array.isArray(layout.tray) ? layout.tray.filter((c) => c && typeof c === 'object') : [],
  })
}

/**
 * Rate every controller for a screen. `motion`: this phone has motion sensors it may use. `host`: the screen's name,
 * for the reasons. The list comes back in the catalogue's order; `byFit` sorts it best first.
 */
export function rateControllers(layout: RatedLayout, device: { motion: boolean }, host = 'This screen'): Rating[] {
  const named = Array.isArray(layout.controllers) ? [...new Set(layout.controllers.filter(isControllerId))] : []
  const modes = Array.isArray(layout.modes) ? layout.modes : named.length ? [...new Set(named.flatMap((c) => CONTROLLERS[c].modes))] : [Mode.hold, Mode.point]
  const offered = putForward(layout)
  const utilities = Array.isArray(layout.utilities) ? layout.utilities : null
  const has = (u: UtilityId) => !utilities || utilities.includes(u)
  const keyboard = Array.isArray(layout.tray) && layout.tray.some((c) => c?.type === 'keyboard')
  const takes = (id: ControllerId): boolean => {
    if (layout.universal) return true
    // Music faces only where a screen names them: nothing reaches them through the modes of older screens.
    if (id === Controller.drums || id === Controller.keys) return named.includes(id)
    if (id === Controller.keyboard) return keyboard || named.includes(id)
    if (!CONTROLLERS[id].modes.some((m) => modes.includes(m))) return false
    const n = NEEDS[id]
    return (n.all ?? []).every(has) && (!n.any || n.any.some(has))
  }
  const profile = isProfileId(layout.profile) ? layout.profile : null
  // What it names first, else what its profile tunes, else the face of its first mode (a screen from before controllers).
  const best = named.find(takes) ?? (profile ? [profile === 'driving' ? Controller.wheel : Controller.gamepad].find(takes) : undefined) ?? (named.length ? undefined : offered.find(takes)) ?? null
  return CONTROLLER_IDS.map((id) => {
    const ok = takes(id)
    const fit: Fit = !ok ? 0 : id === best ? 3 : offered.includes(id) ? 2 : 1
    const steerOnly = id === Controller.wheel && modes.includes(Mode.gamepad)
    return { id, fit, best: id === best, needsMotion: ok && !device.motion && MOTION.has(id), why: ok ? '' : whyNot(id, host, steerOnly) }
  })
}

/**
 * The ratings best first: by fit, then in the order the screen put them forward (the order it names them, or its
 * modes), then in the catalogue's order.
 */
export function byFit(ratings: readonly Rating[], layout: RatedLayout): Rating[] {
  const order = putForward(layout)
  const place = (id: ControllerId) => { const i = order.indexOf(id); return i < 0 ? order.length + CONTROLLER_IDS.indexOf(id) : i }
  return [...ratings].sort((a, b) => b.fit - a.fit || place(a.id) - place(b.id))
}

/**
 * The controller bar: one slot per face the screen takes, in the order of its best controller, each showing the
 * controller in use on it or else its best. So the bar never holds two of one face (the Wii remote and the air mouse),
 * and keeps its order when a variant is picked. The keyboard isn't in it: it opens from the tray.
 */
export function barSlots(sorted: readonly Rating[], current: ControllerId): { face: Face; id: ControllerId }[] {
  const slots = new Map<Face, ControllerId>()
  for (const r of sorted) {
    const face = FACE_OF[r.id]
    if (face && r.fit > 0 && !slots.has(face)) slots.set(face, r.id)
  }
  const mine = FACE_OF[current]
  if (mine && slots.has(mine) && sorted.some((r) => r.id === current && r.fit > 0)) slots.set(mine, current)
  return [...slots].map(([face, id]) => ({ face, id }))
}

/**
 * Where to go when the screen stops taking the controller in use (a new layout): nowhere if it still takes it, else the
 * best one it does take that has a face. Null: it takes none.
 */
export function fallback(sorted: readonly Rating[], current: ControllerId): ControllerId | null {
  if (sorted.some((r) => r.id === current && r.fit > 0)) return current
  return sorted.find((r) => r.fit > 0 && FACE_OF[r.id])?.id ?? null
}

/** Which of a shared face's variants is in use: the pointing face as a Wii remote or an air mouse, the gamepad as a wheel. */
export interface Variants { point: 'wii' | 'mouse'; wheel: boolean }

/** The controller a face stands for, with these variants. */
export function controllerOn(face: Face, v: Variants): ControllerId {
  switch (face) {
    case 'gamepad': return v.wheel ? Controller.wheel : Controller.gamepad
    case 'point': return v.point === 'mouse' ? Controller.mouse : Controller.wii
    case 'track': return Controller.hand
    case 'drums': return Controller.drums
    case 'keys': return Controller.keys
    default: return Controller.trackpad
  }
}

/** What picking a controller sets: its face, and on a shared face the variant (null for the keyboard, which only opens). */
export function choiceFor(id: ControllerId): { face: Face; point?: Variants['point']; wheel?: boolean } | null {
  const face = FACE_OF[id]
  if (!face) return null
  if (face === 'point') return { face, point: id === Controller.mouse ? 'mouse' : 'wii' }
  if (face === 'gamepad') return { face, wheel: id === Controller.wheel }
  return { face }
}
