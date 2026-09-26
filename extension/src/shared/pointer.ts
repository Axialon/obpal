/**
 * The Wii-style pointer on a page (CATALOGUE §4): where the phone points becomes a cursor, A clicks at it and holding
 * B drags; under pointer lock the same stream becomes relative mouse movement (a gyro mouse). Pure: the mapper returns
 * what to draw and which events to fire; the MAIN-world page script dispatches them.
 */
import { Accum, clamp } from './math'
import type { PointerTuple } from './messages'

/** Yaw that reaches the left or right edge of the screen, degrees (the Point-mode geometry of PROTOCOL §4). */
export const POINT_HALF_FOV = 16
/** Past this angle tan() runs away; the point just stays far off-screen. */
const LIMIT = 75
/** The edge turn zone: the last 12% of the screen on each side (CATALOGUE §4). */
export const EDGE_BAND = 0.12
/** Screen px per degree of aim under pointer lock (the keys mapper's aim gain). */
export const LOCK_PX_PER_DEG = 14
/** The wire carries 0.01° in an int16 (65536 steps), so relative accumulators wrap at 655.36°. */
const WRAP_STEPS = 65536

const D2R = Math.PI / 180
export const PointerBit = { valid: 1, relative: 2, edgeTurn: 4 } as const

/** Where a pointing ray meets the screen: x = cx + tan(yaw)·K with K = (width / 2) / tan(16°). */
export function projectPointer(yaw: number, pitch: number, w: number, h: number): { x: number; y: number; off: boolean } {
  const K = w / 2 / Math.tan(POINT_HALF_FOV * D2R)
  const lim = (a: number) => clamp(a, -LIMIT, LIMIT) * D2R
  const x = w / 2 + Math.tan(lim(yaw)) * K
  const y = h / 2 - Math.tan(lim(pitch)) * K
  return { x, y, off: x < 0 || x >= w || y < 0 || y >= h }
}

/** Right-stick deflection toward a screen edge, in proportion to how far into the last `band` the cursor is. */
export function edgeTurn(x: number, y: number, w: number, h: number, band = EDGE_BAND): [number, number] {
  const axis = (v: number, size: number) => {
    const z = size * band
    if (z <= 0) return 0
    if (v < z) return -clamp(1 - v / z, 0, 1)
    if (v > size - z) return clamp((v - (size - z)) / z, 0, 1)
    return 0
  }
  return [axis(x, w), axis(y, h)]
}

/** Wrap-safe change of one pointer angle (degrees), in whole wire steps so no float error creeps in. */
const dAngle = (a: number, b: number) => (((Math.round((a - b) * 100) % WRAP_STEPS) + WRAP_STEPS * 1.5) % WRAP_STEPS - WRAP_STEPS / 2) / 100

/** Change of aim between two pointer samples as the STATE aim convention [yaw + left, pitch + up]; zero across a recentre. */
export function pointerAim(cur: PointerTuple, prev: PointerTuple | null): [number, number] {
  if (!prev || prev[2] !== cur[2]) return [0, 0]
  return [-dAngle(cur[0], prev[0]), dAngle(cur[1], prev[1])]
}

export interface PointerFrame {
  pt: PointerTuple | null
  /** The frame's viewport, CSS px. */
  w: number
  h: number
  /** The page has captured the mouse (document.pointerLockElement). */
  locked: boolean
}

/** One thing for the page script to do. Coordinates are client px in the frame; dx/dy are whole pixels. */
export type PointerAct =
  | { type: 'cursor'; x: number; y: number; grab: boolean; off: boolean }
  | { type: 'hide' }
  | { type: 'hover'; x: number; y: number; dx: number; dy: number }
  | { type: 'down'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; dx: number; dy: number }
  | { type: 'up'; x: number; y: number; click: boolean }
  | { type: 'lock'; dx: number; dy: number; buttons: number }

export interface PointerOut {
  acts: PointerAct[]
  /** Right-stick deflection to add to the pad (the edge turn), or zero. */
  stick: [number, number]
}

/**
 * Stateful pointer -> cursor / click / drag / gyro-mouse mapper. Call update() once per input frame.
 *   Absolute pointer, no lock:  a cursor; A presses, releases and clicks; B holds the left button and drags.
 *   Pointer lock:               relative movementX/Y from the change of aim; A and B are the left button.
 *   Relative pointer, no lock:  nothing here (the link mixes it into the right stick before the pad reaches the page).
 */
export class PointerMapper {
  private last: PointerTuple | null = null
  private cursor: { x: number; y: number } | null = null
  /** Which phone button holds the left mouse button: 0 none, 1 A, 2 B. */
  private held: 0 | 1 | 2 = 0
  private lockAcc = new Accum()
  private moveAcc = new Accum()

  constructor(public pxPerDeg = LOCK_PX_PER_DEG) {}

  get dragging() { return this.held !== 0 }

  update(f: PointerFrame): PointerOut {
    const pt = f.pt
    if (!pt) return { acts: this.release(), stick: [0, 0] }
    const acts: PointerAct[] = []
    const prev = this.last
    this.last = pt
    const [yaw, pitch, , flags, ab] = pt
    const relative = (flags & PointerBit.relative) !== 0
    const a = (ab & 1) !== 0
    const b = (ab & 2) !== 0
    const wasA = !!prev && (prev[4] & 1) !== 0
    const wasB = !!prev && (prev[4] & 2) !== 0

    if (f.locked || relative) {
      if (this.cursor) { this.cursor = null; acts.push({ type: 'hide' }) }
      if (relative && !f.locked) { this.lockAcc.reset(); return { acts, stick: [0, 0] } }
      const [dyaw, dpitch] = prev && prev[2] === pt[2] ? [dAngle(yaw, prev[0]), dAngle(pitch, prev[1])] : [0, 0]
      const buttons = this.held ? 1 : 0
      const [dx, dy] = this.lockAcc.take(dyaw * this.pxPerDeg, -dpitch * this.pxPerDeg)
      if (dx || dy) acts.push({ type: 'lock', dx, dy, buttons })
      if (!relative) this.buttons(acts, a, b, wasA, wasB, 0, 0)
      return { acts, stick: [0, 0] }
    }

    const p = projectPointer(yaw, pitch, f.w, f.h)
    const x = clamp(Math.round(p.x), 0, Math.max(0, f.w - 1))
    const y = clamp(Math.round(p.y), 0, Math.max(0, f.h - 1))
    const [dx, dy] = this.cursor ? this.moveAcc.take(x - this.cursor.x, y - this.cursor.y) : [0, 0]
    this.cursor = { x, y }
    if (dx || dy) acts.push(this.held ? { type: 'drag', x, y, dx, dy } : { type: 'hover', x, y, dx, dy })
    this.buttons(acts, a, b, wasA, wasB, x, y)
    acts.push({ type: 'cursor', x, y, grab: this.held === 2, off: p.off })
    const stick: [number, number] = flags & PointerBit.edgeTurn ? edgeTurn(x, y, f.w, f.h) : [0, 0]
    return { acts, stick }
  }

  /** A presses and clicks; B holds. Whichever went down first owns the button until it is released. */
  private buttons(acts: PointerAct[], a: boolean, b: boolean, wasA: boolean, wasB: boolean, x: number, y: number) {
    if (this.held === 1 && !a) { this.held = 0; acts.push({ type: 'up', x, y, click: true }) }
    else if (this.held === 2 && !b) { this.held = 0; acts.push({ type: 'up', x, y, click: false }) }
    if (this.held) return
    if (a && !wasA) { this.held = 1; acts.push({ type: 'down', x, y }) }
    else if (b && !wasB) { this.held = 2; acts.push({ type: 'down', x, y }) }
  }

  /** Let go: lift a held button and hide the cursor (mode change, lost link, pointer switched off). */
  release(): PointerAct[] {
    const acts: PointerAct[] = []
    const c = this.cursor ?? { x: 0, y: 0 }
    if (this.held) { this.held = 0; acts.push({ type: 'up', x: c.x, y: c.y, click: false }) }
    if (this.cursor) { this.cursor = null; acts.push({ type: 'hide' }) }
    this.last = null
    this.lockAcc.reset()
    this.moveAcc.reset()
    return acts
  }
}
