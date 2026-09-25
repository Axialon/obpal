/**
 * Frame routing and wire encoding for the offscreen link. Pure.
 *
 * A tab can hold many frames (a game in an iframe, ads, widgets). Like real hardware:
 *  - the virtual controller is visible to every frame (the Gamepad API is per frame),
 *  - keys go to the one focused frame,
 *  - 3D drags go to the frame with the largest visible canvas / <model-viewer>.
 */
import { MIN_VIEW_AREA, TARGET_MODES, type TargetMode } from './constants'
import type { DeltaTuple, InputFrame, ModeIndex, PadTuple } from './messages'

export interface FrameInfo {
  /** Browser frame id; 0 is the top frame. */
  frameId: number
  /** Reported by the frame: it has focus and is the innermost focused frame. */
  focus: boolean
  /** When focus was last reported true (for picking the newest if several claim it). */
  focusAt: number
  /** Largest visible canvas / model-viewer, CSS px². */
  area: number
}

export type Role = 'keys' | 'viewer'

export function electFrame<T extends FrameInfo>(frames: readonly T[], role: Role): T | null {
  if (!frames.length) return null
  const top = frames.find((f) => f.frameId === 0) ?? frames[0]
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

export function tiltTuple(t: readonly number[] | null): [number, number] | null {
  if (!t) return null
  const v: [number, number] = [round(Math.max(-1, Math.min(1, t[0])), 1e3), round(Math.max(-1, Math.min(1, t[1])), 1e3)]
  return v[0] || v[1] ? v : null
}

/** Is anything being pressed or moved? Active input streams at the full rate; idle input only heartbeats. */
export function isActive(p: PadTuple | null, d: DeltaTuple | null, tl: [number, number] | null): boolean {
  if (d || tl) return true
  if (!p) return false
  return p[0] !== 0 || p.slice(1).some((v) => Math.abs(v) > 0.02)
}

export const modeIndex = (mode: TargetMode) => TARGET_MODES.indexOf(mode) as ModeIndex

export function buildFrame(mode: TargetMode, dt: number, p: PadTuple | null, d: DeltaTuple | null, tl: [number, number] | null): InputFrame {
  return { t: 'in', m: modeIndex(mode), dt: round(Math.max(0, Math.min(1000, dt)), 10), p, d, tl }
}

/** Identity of the held (non-delta) state; a change is sent at once even when idle. */
export const frameSignature = (mode: TargetMode, p: PadTuple | null, tl: [number, number] | null) => JSON.stringify([mode, p, tl])
