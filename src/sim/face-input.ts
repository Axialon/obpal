/** Shared fallback from a controller face to the channels device sims already consume. */
import { emptyPad, Mode, PadButton, type ControllerId } from '@obpal/core'
import { clamp, slopeOf, panTiltOf } from './devices/input'
import { restInput, type DeviceInput } from './devices/types'
import { readMusic } from '../music'

const finite = (v: number, limit = 1) => Number.isFinite(v) ? clamp(v, -limit, limit) : 0
export const ALL_SIM_FACES = ['face.gamepad', 'face.wheel', 'face.wii', 'face.mouse', 'face.trackpad', 'tilt', 'face.hand', 'hand', 'body', 'face.keys', 'face.keyboard', 'face.drums'] as const

/** Native mappings stay intact. Other faces share a bounded stick, drag and action fallback. */
export function mapFaceInput(id: string, native: readonly string[], input: DeviceInput, dt: number): DeviceInput {
  if (input.quiet) return { ...restInput(input.face, input.mode), quiet: true, presses: input.presses, values: input.values }
  if (!input.pad && (input.pose && (!input.pose.tracked || !input.pose.touching) || input.hand?.tracked === false || input.body?.tracked === false)) {
    // Native spatial consumers must see release/loss to forget their own clutch anchors.
    if (input.pose && !input.hand && !input.body && native.includes(input.face) && ['drone', 'claw', 'painter', 'gimbal', 'arm'].includes(id)) return input
    return { ...restInput(input.face, input.mode), pad: emptyPad(), pose: input.pose, hand: input.hand, body: input.body, presses: input.presses, values: input.values }
  }
  const direct = native.includes(input.face) && !input.hand && !input.body && !input.text && !input.presses.some(p => p.startsWith('key-')) && (!input.pose || ['drone', 'claw', 'painter', 'gimbal', 'arm'].includes(id)) && !['face.keys', 'face.drums'].includes(input.face)
  if (direct && (id !== 'marblerun' || !input.pad && input.face === 'face.trackpad') && (id !== 'pinball' || input.mode !== Mode.tilt || !!input.pad)) return input
  const frame = finite(dt, 0.05)
  let x = 0, y = 0, rx = 0, ry = 0
  let active = input.touching || input.held.has('wii-b') || input.held.has('mouse-left')
  if (input.pad) {
    ;[x, y, rx, ry] = input.pad.axes
    active = true
  } else if (input.pose) {
    active = input.pose.tracked && input.pose.touching
    const slope = slopeOf(input.pose.q), turn = panTiltOf(input.pose.q)
    x = slope[0] || input.pose.p[0] * 2 || turn[0]
    y = slope[1] || -input.pose.p[1] * 2 || turn[1]
    rx = turn[0]; ry = -turn[1]
  } else if (input.hand?.tracked) {
    active = input.touching
    x = input.hand.p[0] * 4; y = -input.hand.p[1] * 4
  } else if (input.body?.tracked) {
    active = input.touching
    const wrist = input.body.landmarks[16], shoulder = input.body.landmarks[12]
    if (wrist && shoulder) { x = (wrist[0] - shoulder[0]) * 3; y = -(wrist[1] - shoulder[1]) * 3 }
  } else if (input.point) {
    x = input.space?.aim[0] ?? input.point.yaw / 35
    y = -(input.space?.aim[1] ?? input.point.pitch / 35)
    rx = x; ry = y
  } else if (input.hold) {
    ;[x, y] = slopeOf(input.hold)
    const turn = panTiltOf(input.hold)
    x ||= turn[0]; y ||= -turn[1]
  } else {
    x = input.space?.active ? input.space.tilt[0] : input.tilt[0]
    y = input.space?.active ? input.space.tilt[1] : input.tilt[1]
    x ||= input.drag[0] / 12; y ||= input.drag[1] / 12
    rx = input.pan[0] / 12; ry = input.pan[1] / 12
    active ||= !!input.space?.active || input.mode === Mode.tilt && !!(input.tilt[0] || input.tilt[1])
  }
  // Key caps on the phone send key-code presses; typed WASD also supplies a short jog.
  const keys = new Set([...input.presses, ...[...input.text.toLowerCase()].map(c => `key-Key${c.toUpperCase()}`)])
  if (keys.size) {
    x ||= Number(keys.has('key-KeyD') || keys.has('key-ArrowRight')) - Number(keys.has('key-KeyA') || keys.has('key-ArrowLeft'))
    y ||= Number(keys.has('key-KeyS') || keys.has('key-ArrowDown')) - Number(keys.has('key-KeyW') || keys.has('key-ArrowUp'))
    active ||= !!(x || y)
  }
  const music = input.values.map(v => v.id === 'music.event' ? readMusic(v.v) : null).find(e => e && ['hit', 'on', 'air'].includes(e.op))
  if (music) { active = true; x ||= music.x || (music.n % 2 ? .7 : -.7); y ||= -music.v }
  const action = !!music && !['studio', 'maze'].includes(id) || keys.has('key-Enter') || input.presses.some(p => ['pad', 'wii-a', 'mouse-left'].includes(p))
  const pad = input.pad ? { ...input.pad, axes: input.pad.axes.map(v => finite(v)) as [number, number, number, number], triggers: input.pad.triggers.map(v => clamp(finite(v), 0, 1)) as [number, number] } : emptyPad()
  if (!input.pad) {
    pad.axes = active ? [finite(x), finite(y), finite(rx || x), finite(ry || y)] : [0, 0, 0, 0]
    pad.triggers = [0, clamp(-finite(input.pan[1] / 12) - finite(input.wheel / 1200) + (id === 'slotcars' ? Math.hypot(x, y) : 0), 0, 1)]
  }
  if (keys.size) { pad.axes[0] ||= finite(x); pad.axes[1] ||= finite(y) }
  if (action) pad.buttons |= 1 << PadButton.A
  // A wheel's pedals are its forward/back channel on non-driving devices.
  if (input.face === 'face.wheel') pad.axes[1] ||= pad.triggers[0] - pad.triggers[1]
  // Button-driven tables need a deliberate held movement to reach their flippers and plunger.
  if (id === 'pinball' && !input.pad) {
    if (pad.axes[0] < -.12) pad.buttons |= 1 << PadButton.LB
    if (pad.axes[0] > .12) pad.buttons |= 1 << PadButton.RB
    pad.triggers[1] = Math.max(pad.triggers[1], pad.axes[1])
  }
  const pressed = input.padPressed | (action ? 1 << PadButton.A : 0)
  // Some devices (lamps, blinds, lights) consume gestures instead of sticks.
  return { ...input, mode: Mode.tilt, pad, padPressed: pressed, touching: active,
    point: null, spot: null, pose: null, hold: null, space: undefined,
    tilt: [pad.axes[0], pad.axes[1]],
    drag: active ? [finite(input.drag[0], 90) || pad.axes[0] * frame * 180, finite(input.drag[1], 90) || pad.axes[1] * frame * 180] : [0, 0],
    pan: active ? [finite(input.pan[0], 90) || pad.axes[2] * frame * 180, finite(input.pan[1], 90) || pad.axes[3] * frame * 180] : [0, 0],
    presses: action && !input.presses.includes('pad') ? [...input.presses, 'pad'] : input.presses,
    pinch: finite(input.pinch, 2), twist: finite(input.twist, 90), wheel: finite(input.wheel, 2400),
  }
}

export function recommendedFaces(native: readonly ControllerId[]): ControllerId[] {
  return [...new Set([...native, 'face.gamepad', 'face.wheel', 'face.wii', 'face.mouse', 'face.trackpad', 'face.hand', 'face.keys', 'face.keyboard', 'face.drums'])] as ControllerId[]
}
