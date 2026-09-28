/**
 * The node strip's choice on a device (PROTOCOL §3a): which of a unit's parts the trackpad and tilt drive, and which
 * hold. Pure: it rewrites one frame's input before the device reads it, so each device keeps its own mapping. The one
 * finger goes to the chosen parts' own gestures (the first part takes a drag across, the second a drag up and down, a
 * third and fourth two fingers), every other gesture is dropped, and a locked part hears nothing. Gestures are deltas,
 * so a part chosen mid-drag starts from where it is and the finger carries straight on; tilt keeps its zero.
 */
import { Mode, type SceneNode, type ScenePart, type SceneSet } from '@obpal/core'
import type { Channel, DeviceInput, DevicePart, DeviceSpec } from './types'

/** Tilted all the way, a chosen part moves as a drag of this many px a second does. */
export const TILT_PX = 420
/** A px of the finger, in the gestures a part may read instead: degrees of twist, and log2 of pinch. */
const TWIST_PER_PX = 0.5
const PINCH_PER_PX = 1 / 200

/** What the strip chose for one unit: the parts driven (none: the whole unit, its own way) and the parts that hold. */
export interface UnitFocus { parts: readonly string[]; locks: ReadonlySet<string> }

/** The parts and sets a unit's scene node offers the phone. */
export function sceneParts(spec: DeviceSpec): Pick<SceneNode, 'icon' | 'parts' | 'sets'> {
  if (!spec.parts?.length) return {}
  const parts: ScenePart[] = spec.parts.map((p) => ({ id: p.id, name: p.name, icon: p.icon }))
  const sets: SceneSet[] = (spec.sets ?? []).map((s) => ({ id: s.id, name: s.name, icon: s.icon, parts: [...s.parts], locks: true }))
  return { ...(spec.icon ? { icon: spec.icon } : {}), parts, ...(sets.length ? { sets } : {}) }
}

/** The trackpad face (not the gamepad, pointing or 3D): the one the strip sits on. */
const onTrackpad = (i: DeviceInput) => i.face === 'face.trackpad' && !i.pad

/** A gesture that runs down the pad (+ is down), rather than across it. */
const down = (c: Channel) => c === 'drag.y' || c === 'pan.y'

function put(i: DeviceInput, c: Channel, px: number) {
  if (c === 'drag.x') i.drag[0] += px
  else if (c === 'drag.y') i.drag[1] += px
  else if (c === 'pan.x') i.pan[0] += px
  else if (c === 'pan.y') i.pan[1] += px
  else if (c === 'twist') i.twist += px * TWIST_PER_PX
  else i.pinch += px * PINCH_PER_PX
}
function clear(i: DeviceInput, c: Channel) {
  if (c === 'drag.x') i.drag[0] = 0
  else if (c === 'drag.y') i.drag[1] = 0
  else if (c === 'pan.x') i.pan[0] = 0
  else if (c === 'pan.y') i.pan[1] = 0
  else if (c === 'twist') i.twist = 0
  else i.pinch = 0
}
/** Move a part on (+) or back (−) by `px` of the finger, through its first gesture: on is across, or up. */
const drive = (i: DeviceInput, p: DevicePart, px: number) => put(i, p.channels[0], down(p.channels[0]) ? -px : px)

/** One unit's input for this frame as the strip's choice has it (unchanged off the trackpad, or with nothing chosen). */
export function routeParts(spec: DeviceSpec, input: DeviceInput, focus: UnitFocus | null, dt: number): DeviceInput {
  const all = spec.parts ?? []
  if (!all.length || !focus || !onTrackpad(input) || (!focus.parts.length && !focus.locks.size)) return input
  const i: DeviceInput = { ...input, drag: [input.drag[0], input.drag[1]], pan: [input.pan[0], input.pan[1]], tilt: [input.tilt[0], input.tilt[1]] }
  const locked = all.filter((p) => focus.locks.has(p.id))
  // A locked part keeps its place in the set (its gesture moves nothing), so locking one never moves the others' gestures.
  const chosen = focus.parts.map((id) => all.find((p) => p.id === id)).filter((p): p is DevicePart => !!p)
  const free = (p: DevicePart) => chosen.includes(p) && !focus.locks.has(p.id)
  const turns = all.filter((p) => p.turn)
  if (!focus.parts.length) {
    // The whole unit, its own way, but for what is locked.
    for (const p of locked) for (const c of p.channels) clear(i, c)
    if (locked.some((p) => p.turn)) { i.hold = null; i.space = undefined }
    if (locked.some((p) => p.stick)) i.touching = false
    if (i.mode === Mode.tilt && locked.some((p) => p.stick)) i.tilt = [0, 0]
    return i
  }
  // A part or a set: the one finger (and tilt, while it's down) drives it; nothing else moves.
  const fx = input.drag[0] + (i.mode === Mode.tilt && input.touching ? input.tilt[0] * TILT_PX * dt : 0)
  const fy = input.drag[1] + (i.mode === Mode.tilt && input.touching ? input.tilt[1] * TILT_PX * dt : 0)
  const two = [input.pan[0], input.pan[1]]
  i.drag = [0, 0]; i.pan = [0, 0]; i.twist = 0; i.pinch = 0; i.tilt = [0, 0]
  if (!turns.length || !turns.every(free)) { i.hold = null; i.space = undefined }
  // A drive left behind centres: its stick hears the finger lift.
  if (all.some((p) => p.stick && !free(p))) i.touching = false
  if (chosen.length === 1) {
    const p = chosen[0]
    if (!free(p)) return i
    if (p.channels.length > 1) { put(i, p.channels[0], down(p.channels[0]) ? fy : fx); put(i, p.channels[1], down(p.channels[1]) ? fy : fx) }
    // Alone, it moves on with a drag across or up, whichever way the finger goes.
    else drive(i, p, fx - fy)
  } else {
    // In a set: across, then up and down, then two fingers up and down, then across.
    const on = [fx, -fy, -two[1], two[0]]
    chosen.slice(0, 4).forEach((p, k) => { if (free(p)) drive(i, p, on[k]) })
  }
  return i
}
