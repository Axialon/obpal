/**
 * Frame routing and wire encoding for the offscreen link. Pure.
 *
 * A tab can hold many frames (a game in an iframe, ads, widgets). Like real hardware:
 *  - the virtual controller is visible to every frame (the Gamepad API is per frame),
 *  - keys go to the one focused frame,
 *  - 3D drags go to the frame with the largest visible canvas / <model-viewer>.
 */
import { mixStick, PadButton, rateToUnit, type PointerState } from '@obpal/core'
import { MIN_VIEW_AREA, TARGET_MODES, type TargetMode } from './constants'
import type { DeltaTuple, InputFrame, ModeIndex, PadTuple, PointerTuple } from './messages'

export interface FrameInfo {
  /** Browser frame id; 0 is the top frame. */
  frameId: number
  /** Reported by the frame: it has focus and is the innermost focused frame. */
  focus: boolean
  /** When focus was last reported true (for picking the newest if several claim it). */
  focusAt: number
  /** Largest visible canvas / model-viewer, CSS px². */
  area: number
  /** Reported by the frame: it holds the pointer lock (the game captured the mouse). */
  lock?: boolean
}

/** keys: the focused frame. viewer: the largest canvas. pointer: a pointer-locked frame, else the largest canvas. */
export type Role = 'keys' | 'viewer' | 'pointer'

export function electFrame<T extends FrameInfo>(frames: readonly T[], role: Role): T | null {
  if (!frames.length) return null
  const top = frames.find((f) => f.frameId === 0) ?? frames[0]
  if (role === 'pointer') {
    const locked = frames.find((f) => f.lock)
    if (locked) return locked
  }
  let best: T | null = null
  for (const f of frames) {
    if (role === 'keys' ? f.focus && (!best || f.focusAt > best.focusAt) : f.area >= MIN_VIEW_AREA && (!best || f.area > best.area)) best = f
  }
  return best ?? top
}

/** Which frames get input frames in a mode: every frame for the controller, one elected frame otherwise. */
export function recipients<T extends FrameInfo>(frames: readonly T[], mode: TargetMode): T[] {
  if (mode === 'gamepad') return [...frames]
  const f = electFrame(frames, mode === 'keys' ? 'keys' : 'viewer')
  return f ? [f] : []
}

const round = (v: number, k: number) => Math.round(v * k) / k || 0

export interface PadLike { buttons: number; axes: readonly number[]; triggers: readonly number[] }

export function padTuple(pad: PadLike | null): PadTuple | null {
  if (!pad) return null
  const ax = (i: number) => round(Math.max(-1, Math.min(1, pad.axes[i] ?? 0)), 1e4)
  const tr = (i: number) => round(Math.max(0, Math.min(1, pad.triggers[i] ?? 0)), 1e3)
  return [pad.buttons >>> 0, ax(0), ax(1), ax(2), ax(3), tr(0), tr(1)]
}

export interface FrameDeltas { aim: readonly number[]; pad1: readonly number[]; pad2: readonly number[]; zoom: number }

/** Per-frame deltas, or null when there is no motion at all (keeps idle frames tiny). */
export function deltaTuple(f: FrameDeltas): DeltaTuple | null {
  const d: DeltaTuple = [
    round(f.aim[0], 1e3), round(f.aim[1], 1e3), round(f.pad1[0], 1e3), round(f.pad1[1], 1e3),
    round(f.pad2[0], 1e3), round(f.pad2[1], 1e3), round(f.zoom, 1e4),
  ]
  return d.some((v) => v !== 0) ? d : null
}

/** The pointer for a page, with the A / B bits of the pad that click at it. */
export function pointerTuple(p: PointerState | null, buttons: number): PointerTuple | null {
  if (!p) return null
  return [round(p.yaw, 100), round(p.pitch, 100), p.gen & 0xff, p.flags & 0xff, buttons & 3]
}

/** The A and B bits removed: while they click at the cursor they are not also gamepad buttons (CATALOGUE §4). */
export function withoutClickButtons(p: PadTuple | null): PadTuple | null {
  if (!p) return null
  const out: PadTuple = [...p]
  out[0] = (p[0] & ~((1 << PadButton.A) | (1 << PadButton.B))) >>> 0
  return out
}

/**
 * Aim on the mouse route without pointer lock: the host finishes the route on the right stick (CATALOGUE §3, shooter),
 * turning the change of aim per second into a deflection with the default deadzone jump. Signs: yaw + = right, pitch + = up.
 */
export function withRelativeAim(p: PadTuple | null, rateDps: readonly [number, number], deadzone = 0.2): PadTuple | null {
  if (!p) return null
  const v = rateToUnit(-rateDps[0], rateDps[1])
  const [rx, ry] = mixStick([p[3], p[4]], [{ v, deadzone }])
  const out: PadTuple = [...p]
  out[3] = round(rx, 1e4)
  out[4] = round(ry, 1e4)
  return out
}

export function tiltTuple(t: readonly number[] | null): [number, number] | null {
  if (!t) return null
  const v: [number, number] = [round(Math.max(-1, Math.min(1, t[0])), 1e3), round(Math.max(-1, Math.min(1, t[1])), 1e3)]
  return v[0] || v[1] ? v : null
}

/** Is anything being pressed or moved? Active input streams at the full rate; idle input only heartbeats. */
export function isActive(p: PadTuple | null, d: DeltaTuple | null, tl: [number, number] | null, pt: PointerTuple | null = null): boolean {
  if (d || tl || pt) return true
  if (!p) return false
  return p[0] !== 0 || p.slice(1).some((v) => Math.abs(v) > 0.02)
}

export const modeIndex = (mode: TargetMode) => TARGET_MODES.indexOf(mode) as ModeIndex

export function buildFrame(mode: TargetMode, dt: number, p: PadTuple | null, d: DeltaTuple | null, tl: [number, number] | null, pt: PointerTuple | null = null): InputFrame {
  const f: InputFrame = { t: 'in', m: modeIndex(mode), dt: round(Math.max(0, Math.min(1000, dt)), 10), p, d, tl }
  if (pt) f.pt = pt
  return f
}

/** Identity of the held (non-delta) state; a change is sent at once even when idle. */
export const frameSignature = (mode: TargetMode, p: PadTuple | null, tl: [number, number] | null) => JSON.stringify([mode, p, tl])
