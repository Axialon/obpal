/**
 * What the harness measures of a marble, frame by frame: how far it moved on screen as drawn (CSS and device pixels),
 * jumps its speed doesn't explain (a teleport), how deep it is in anything solid (a letter, a raised thing, the floor, an
 * edge of the screen as drawn), and how many things it touches (and how often that count changes while it should be
 * still).
 */
import { inside, nearest, type Footprint, type Orb, type Wall } from '../../src/landing/bounce'
import { DEPTH, type WorldMarble } from '../../src/landing/world'
import type { Harness } from './world'

/** The marble's signed distance to a letter or a raised thing (a footprint raised to its height): negative inside it. */
export function distTo(fp: Footprint, x: number, y: number, z: number): number {
  const b = fp.box
  if (x < b[0] - 1 || x > b[2] + 1 || z < b[1] - 1 || z > b[3] + 1) return Infinity
  const e = nearest(fp, x, z)
  const s = inside(fp, x, z) ? -e.d : e.d
  if (s <= 0) return y >= fp.height ? y - fp.height : -Math.min(-s, fp.height - y)
  return y <= fp.height ? s : Math.hypot(s, y - fp.height)
}

/** How far inside a wall the marble is, as drawn (negative: overlapping it). */
export function wallGap(w: Wall, o: Orb): number {
  const rho = o.r * (1 + DEPTH * Math.max(0, o.y - o.r))
  return w.n[0] * o.x + w.n[1] * o.y + w.n[2] * o.z + w.d - rho
}

export interface Sample { t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; sx: number; sy: number; pen: number; wallPen: number; contacts: number; resting: boolean }

/** A frame of a marble: where it's drawn (on screen), where it is (em), how deep in anything, what it touches. */
export function sample(h: Harness, m: WorldMarble, t: number): Sample {
  const o = m.orb
  const p = h.world.project(m.shown[0], m.shown[1], m.shown[2])
  let pen = Math.max(0, o.r - o.y), contacts = o.y - o.r < 1e-3 ? 1 : 0
  for (const fp of [...h.world.footprints, ...h.world.pads]) {
    const d = distTo(fp, o.x, o.y, o.z)
    if (d === Infinity) continue
    pen = Math.max(pen, o.r - d)
    if (d < o.r + 1e-3) contacts++
  }
  let wallPen = 0
  for (const w of h.world.walls) {
    const g = wallGap(w, o)
    wallPen = Math.max(wallPen, -g)
    if (g < 1e-3) contacts++
  }
  return { t, x: o.x, y: o.y, z: o.z, vx: o.vx, vy: o.vy, vz: o.vz, sx: p.x, sy: p.y, pen: Math.max(0, pen), wallPen, contacts, resting: o.resting }
}

export interface Summary {
  frames: number
  /** The most it moved on screen in one frame (CSS px, and device px at the layout's DPR), and the 99th percentile. */
  maxPx: number
  maxDevPx: number
  p99Px: number
  /** Frames it moved at all on screen (over 0.01 px), and visibly (over 0.1 px). */
  movedFrames: number
  visibleFrames: number
  /** Jumps its speed doesn't explain, over a quarter of its radius (em): how many, and the biggest (em and px). */
  teleports: number
  maxJump: number
  maxJumpPx: number
  /** The deepest it was in anything solid (em), and past an edge of the screen as drawn. */
  maxPen: number
  maxWallPen: number
  /** How often the number of things it touched changed between frames. */
  contactFlips: number
  /** Frames with the marble asleep. */
  restFrames: number
}

export function summarize(h: Harness, s: Sample[]): Summary {
  const dpr = h.layout.dpr
  const moves: number[] = []
  let teleports = 0, maxJump = 0, maxJumpPx = 0, flips = 0, maxPen = 0, maxWallPen = 0, rest = 0
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i]
    const px = Math.hypot(b.sx - a.sx, b.sy - a.sy)
    moves.push(px)
    const dt = (b.t - a.t) / 1000
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    const v = Math.max(Math.hypot(a.vx, a.vy, a.vz), Math.hypot(b.vx, b.vy, b.vz))
    const jump = d - v * Math.min(dt, 0.12) * 1.1
    if (jump > 0.05) teleports++
    if (jump > maxJump) { maxJump = jump; maxJumpPx = px }
    if (b.contacts !== a.contacts) flips++
    maxPen = Math.max(maxPen, b.pen)
    maxWallPen = Math.max(maxWallPen, b.wallPen)
    if (b.resting) rest++
  }
  const sorted = [...moves].sort((x, y) => x - y)
  return {
    frames: s.length,
    maxPx: sorted.at(-1) ?? 0,
    maxDevPx: (sorted.at(-1) ?? 0) * dpr,
    p99Px: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
    movedFrames: moves.filter((m) => m > 0.01).length,
    visibleFrames: moves.filter((m) => m > 0.1).length,
    teleports,
    maxJump,
    maxJumpPx,
    maxPen,
    maxWallPen,
    contactFlips: flips,
    restFrames: rest,
  }
}

/** The deepest point of each counter of a footprint (the centre of the widest circle in it), and that circle's radius. */
export function counters(fp: Footprint, counterOf: (fp: Footprint, x: number, z: number) => Float64Array | null): { x: number; z: number; a: number; hole: Float64Array }[] {
  const found: { x: number; z: number; a: number; hole: Float64Array }[] = []
  const b = fp.box, steps = 80
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = b[0] + ((b[2] - b[0]) * i) / steps, z = b[1] + ((b[3] - b[1]) * j) / steps
      const hole = counterOf(fp, x, z)
      if (!hole) continue
      const a = nearest({ ...fp, rings: [hole] }, x, z).d
      const at = found.find((f) => f.hole === hole)
      if (!at) found.push({ x, z, a, hole })
      else if (a > at.a) Object.assign(at, { x, z, a })
    }
  }
  return found
}

/** Gaps between neighbouring letters narrower than `width` (em): which letters, where, and how wide (their closest approach). */
export function gaps(h: Harness, width: number): { a: number; b: number; x: number; z: number; w: number }[] {
  return h.world.gaps(width)
}

/**
 * Open floor right beside raised thing `i`, straight out from its middle (in front of it, else behind it, left of it,
 * right of it: as it's seen, below it on screen, above, left, right), clear of everything else, and the tilt that runs
 * a marble from there straight into it (degrees toward you and to the right, each -1, 0 or 1).
 */
export function beside(h: Harness, i: number): { x: number; z: number; down: number; right: number } {
  const pad = h.world.pads.find((p) => p.id === 1000 + i)
  if (!pad) throw new Error(`no raised thing ${i}`)
  const [cx, cz] = pad.spot
  const r = 0.2
  for (const [dx, dz] of [[0, 1], [0, -1], [-1, 0], [1, 0]]) {
    for (let d = 0; d < 3; d += 0.01) {
      const x = cx + dx * d, z = cz + dz * d
      const near = distTo(pad, x, r, z)
      if (near < r + 0.02) continue
      // Right beside it, and nothing else as near.
      if (near > r + 0.06) break
      if (h.world.surface(x, z).id === -1 && [...h.world.pads, ...h.world.footprints].every((fp) => fp === pad || distTo(fp, x, r, z) > r + 0.03)) return { x, z, down: -dz, right: -dx }
    }
  }
  throw new Error(`no open floor beside raised thing ${i}`)
}
