/**
 * The blocks on the floor and the arms among them, as geometry. Pure, unit-tested in node. Every part of an arm is a
 * box (the shapes ./model.ts builds, boxed), and so is every block, and nothing passes through anything else:
 *   - A part that runs into a block from the side pushes it along the floor, gripping it a little as it goes, and the
 *     block stops when the push does (quasi-static pushing: the floor's friction). Pushed off its middle, a block
 *     turns as well, the way a box pushed at one end turns on a table (the ellipsoid limit surface of its footprint's
 *     friction). A pushed block pushes the blocks it runs into, and stays out of the arms' bases.
 *   - A part coming down on a block stops on its top, as on the floor; so does one that would pin a block against
 *     something that can't give way. The fewest joints that keep every part out of it stop there.
 *   - A block between the fingers as they close is kept between them, pushed to their middle and turned square to
 *     them; once it can't turn or move any further, the fingers stop on its faces and hold it.
 *   - A real arm is never stopped or moved by blocks that aren't really there: it pushes them out of its way.
 * World metres, y up. A block stands upright: turned only about the vertical (yaw, as three.js turns it).
 */
import { byFingers, FINGER_W, fingerAt, openingFor, type GripBox, type V3 } from './grasp'
import { ARM, FLOOR_CLEAR, lowest, stepAboveFloor, type ArmPose } from './kinematics'

/** An oriented box: its middle, its axes (unit vectors) and its half-sizes along them. */
export type Box = GripBox

/** A free block: its middle, how far it's turned about the vertical, and its half-sizes (x, y up, z). */
export interface Blk { x: number; y: number; z: number; yaw: number; half: V3 }
/** Where an arm stands: the middle of its base, and how it's turned about the vertical (the model's root). */
export interface Stand { x: number; z: number; turn: number }
/** An arm's base, which never moves: a column standing on the floor there (./model.ts). */
export interface Base { x: number; z: number }
/** A joint a block can stop: the arm's five, and the gripper. */
export type Key = 'yaw' | 'shoulder' | 'elbow' | 'wrist' | 'roll' | 'grip'

const D2R = Math.PI / 180
/** Overlap this small is touching (m); a push takes a block this much further. */
const TOL = 0.0002
const MARGIN = 0.0001
/** An arm steps among blocks so that no part moves further than this at a time (m): nothing slips through anything. */
const SUB = 0.004
const MAX_SUB = 40
/** Rounds of pushing before a block still in something counts as pinned. */
const ROUNDS = 10
/** The most a block turns in one push (rad). */
const MAX_TURN = 0.2
/** A part's grip on a block it pushes (friction coefficient): it drags the block along with it this much. */
const GRIP = 0.4
/** A base's column: two cylinders, radius, bottom and top (m). */
const COLUMN: readonly [number, number, number][] = [[0.27, 0, 0.1], [0.19, 0.1, 0.26]]

// ---- vectors and frames ----

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])

/** A frame in the world: x ↦ R·x + t (R row-major). */
export interface Frame { R: number[]; t: V3 }
const rotY = (a: number) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c] }
const rotZ = (a: number) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1] }
const mulR = (A: number[], B: number[]) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]))
const mulV = (R: number[], v: V3): V3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]]
const mulTV = (R: number[], v: V3): V3 => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]]
const col = (R: number[], i: number): V3 => [R[i], R[3 + i], R[6 + i]]
const place = (f: Frame, v: V3): V3 => { const r = mulV(f.R, v); return [r[0] + f.t[0], r[1] + f.t[1], r[2] + f.t[2]] }
const then = (f: Frame, R: number[], t: V3): Frame => ({ R: mulR(f.R, R), t: place(f, t) })

/** An arm's joints' frames in the world, nested as ./model.ts nests them. */
export function armFrames(s: Stand, p: ArmPose) {
  const root: Frame = { R: rotY(s.turn), t: [s.x, 0, s.z] }
  const yaw = then(root, rotY(p.yaw * D2R), [0, 0.1, 0])
  const shoulder = then(yaw, rotZ(p.shoulder * D2R), [0, ARM.H0 - 0.1, 0])
  const elbow = then(shoulder, rotZ(p.elbow * D2R), [0, ARM.L1, 0])
  const wrist = then(elbow, rotZ(p.wrist * D2R), [0, ARM.L2, 0])
  const roll = then(wrist, rotY(p.roll * D2R), [0, 0.12, 0])
  const grasp = then(roll, [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, ARM.LT - 0.12, 0])
  return { shoulder, elbow, wrist, roll, grasp }
}

// ---- the arm's parts and the blocks, as boxes ----

type Joint = 'shoulder' | 'elbow' | 'wrist' | 'roll'
/**
 * The arm's moving parts, each a box in its joint's frame (./model.ts): the shoulder's hub and ring, the upper arm, the
 * elbow's hub and ring, the forearm, the wrist's hub and ring, its barrel, the roll ring, the palm and the ring under
 * it. A hub or ring is boxed whole, so its box is a little bigger at the corners. The fingers come with the opening.
 */
const SHAPES: readonly [Joint, V3, V3][] = [
  ['shoulder', [0, 0, 0.0085], [0.112, 0.112, 0.1085]],
  ['shoulder', [0, ARM.L1 / 2, 0], [0.05, ARM.L1 / 2, 0.055]],
  ['elbow', [0, 0, 0.0085], [0.094, 0.094, 0.0935]],
  ['elbow', [0, ARM.L2 / 2, 0], [0.04, ARM.L2 / 2, 0.045]],
  ['wrist', [0, 0, 0.0085], [0.077, 0.077, 0.0735]],
  ['wrist', [0, 0.06, 0], [0.045, 0.05, 0.045]],
  ['roll', [0, 0, 0], [0.064, 0.012, 0.064]],
  ['roll', [0, 0.03, 0], [0.07, 0.0175, 0.035]],
  ['roll', [0, 0.05, 0], [0.038, 0.008, 0.038]],
]
/** A finger: half-sizes, and how far along the tool its middle is (in the roll frame). */
const FINGER: V3 = [FINGER_W / 2, 0.05, 0.0275]
const FINGER_Y = 0.095

const boxIn = (f: Frame, c: V3, half: V3): Box => ({ c: place(f, c), axes: [col(f.R, 0), col(f.R, 1), col(f.R, 2)], half })
/** A box given in a frame's own terms (a held block in the gripper's), in the world. */
export const boxOf = (f: Frame, b: Box): Box => ({ c: place(f, b.c), axes: [mulV(f.R, b.axes[0]), mulV(f.R, b.axes[1]), mulV(f.R, b.axes[2])], half: b.half })
/** A box in the world, in a frame's own terms. */
export const boxInto = (f: Frame, b: Box): Box => ({ c: mulTV(f.R, sub(b.c, f.t)), axes: [mulTV(f.R, b.axes[0]), mulTV(f.R, b.axes[1]), mulTV(f.R, b.axes[2])], half: b.half })

/** An arm's parts in the world, at a pose and an opening, with the block it holds (in its grasp frame). */
export function armParts(s: Stand, p: ArmPose, open: number, held?: Box | null): Box[] {
  const f = armFrames(s, p)
  const out = SHAPES.map(([j, c, h]) => boxIn(f[j], c, h))
  const x = fingerAt(open) + FINGER_W / 2
  out.push(boxIn(f.roll, [-x, FINGER_Y, 0], FINGER), boxIn(f.roll, [x, FINGER_Y, 0], FINGER))
  if (held) out.push(boxOf(f.grasp, held))
  return out
}
/** Which of `armParts` are the fingers (the last two before a held block). */
export const FINGERS = [SHAPES.length, SHAPES.length + 1] as const

export function blockBox(b: Blk): Box {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw)
  return { c: [b.x, b.y, b.z], axes: [[c, 0, -s], [0, 1, 0], [s, 0, c]], half: b.half }
}

export function corners(b: Box): V3[] {
  const out: V3[] = []
  for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) {
    const h: V3 = [i * b.half[0], j * b.half[1], k * b.half[2]]
    out.push([0, 1, 2].map((d) => b.c[d] + b.axes[0][d] * h[0] + b.axes[1][d] * h[1] + b.axes[2][d] * h[2]) as V3)
  }
  return out
}

// ---- two boxes: how far apart, or how far in, and where they touch ----

interface Axis { L: V3; gap: number }
const extent = (b: Box, L: V3) => b.half[0] * Math.abs(dot(b.axes[0], L)) + b.half[1] * Math.abs(dot(b.axes[1], L)) + b.half[2] * Math.abs(dot(b.axes[2], L))

/** The separating axes of two boxes, each pointing from `a` toward `b`, with the gap between them along it. */
function axes(a: Box, b: Box): Axis[] {
  const d = sub(b.c, a.c)
  const out: Axis[] = []
  const add = (u: V3) => {
    const L: V3 = dot(d, u) < 0 ? [-u[0], -u[1], -u[2]] : u
    out.push({ L, gap: dot(d, L) - extent(a, L) - extent(b, L) })
  }
  for (const u of a.axes) add(u)
  for (const v of b.axes) add(v)
  for (const u of a.axes) for (const v of b.axes) {
    const w = cross(u, v), l = len(w)
    if (l > 1e-6) add([w[0] / l, w[1] / l, w[2] / l])
  }
  return out
}

/** How far apart two boxes are, along the axis that separates them best: negative when they overlap (by that much). */
export function gap(a: Box, b: Box): number {
  return Math.max(...axes(a, b).map((x) => x.gap))
}

const far = (a: Box, b: Box) => len(sub(a.c, b.c)) > len(a.half) + len(b.half) + TOL
const inBox = (b: Box, p: V3) => { const d = sub(p, b.c); return b.axes.every((u, i) => Math.abs(dot(d, u)) <= b.half[i] + 1e-9) }

/**
 * Part `a` in block `b`: the way along the floor (and how far) that pushes the block clear of it, how far the part would
 * have to rise to clear it instead, and where on the floor they touch (for the turn a push off the block's middle gives
 * it): the corners of each inside the other, or else the middle of the block's face toward the part.
 */
function contact(a: Box, b: Box, ax: Axis[]) {
  let dist = Infinity, lift = Infinity
  let n: [number, number] = [1, 0]
  for (const { L, gap: g } of ax) {
    const h = Math.hypot(L[0], L[2])
    if (h > 0.2 && -g / h < dist) { dist = -g / h; n = [L[0] / h, L[2] / h] }
    if (L[1] < -0.2) lift = Math.min(lift, -g / -L[1])
  }
  const pts = [...corners(b).filter((p) => inBox(a, p)), ...corners(a).filter((p) => inBox(b, p))]
  let at: [number, number]
  if (pts.length) at = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[2], 0) / pts.length]
  else {
    const best = ax.reduce((m, x) => (x.gap > m.gap ? x : m))
    const e = extent(b, best.L)
    at = [b.c[0] - best.L[0] * e, b.c[2] - best.L[2] * e]
  }
  return { n, dist, lift, at }
}

// ---- pushing a block along the floor ----

/**
 * How hard a block resists turning as it's pushed, as a squared lever (m²): the ellipsoid limit surface of its
 * footprint's friction, pressed evenly.
 */
const lever2 = (b: Blk) => (0.88 * (b.half[0] ** 2 + b.half[2] ** 2)) / 3

/**
 * Push a block along the floor so that the point `p` where it's pushed moves `d` along `n`. Pushed through its middle,
 * it slides straight; pushed off it, it turns as well, the more the further off. A pusher that also moves `drag` across
 * `n` there, gripping it (friction `mu`), carries the block along with it as far as its grip lets it (they stick), else
 * slides along it, dragging it with all the grip it has.
 */
function shove(b: Blk, n: [number, number], d: number, p: [number, number], drag = 0, mu = 0) {
  const rx = p[0] - b.x, rz = p[1] - b.z
  const t: [number, number] = [-n[1], n[0]]
  const kn = rz * n[0] - rx * n[1], kt = rz * t[0] - rx * t[1]
  const c2 = lever2(b)
  // How the pushed point moves for a force (fn along n, ft across it): the force, and the turn its lever gives.
  const a11 = 1 + (kn * kn) / c2, a12 = (kn * kt) / c2, a22 = 1 + (kt * kt) / c2
  let fn = d / a11, ft = 0
  if (mu > 0) {
    const det = a11 * a22 - a12 * a12
    const sn = (d * a22 - drag * a12) / det, st = (a11 * drag - a12 * d) / det
    if (sn > 0 && Math.abs(st) <= mu * sn) { fn = sn; ft = st } else {
      const sign = Math.sign(drag) || Math.sign(st) || 1
      const slide = d / (a11 + sign * mu * a12)
      if (slide > 0) { fn = slide; ft = sign * mu * slide }
    }
  }
  const fx = fn * n[0] + ft * t[0], fz = fn * n[1] + ft * t[1]
  b.x += fx
  b.z += fz
  b.yaw += Math.max(-MAX_TURN, Math.min(MAX_TURN, (rz * fx - rx * fz) / c2))
}

/** How far the point `p` of a part moved across `n` since the part was at `before`, a step ago, on the floor. */
function dragOf(now: Box, before: Box, p: [number, number], y: number, n: [number, number]) {
  const d = sub([p[0], y, p[1]], now.c)
  const l = [dot(d, now.axes[0]), dot(d, now.axes[1]), dot(d, now.axes[2])]
  const was = [0, 1, 2].map((k) => before.c[k] + before.axes[0][k] * l[0] + before.axes[1][k] * l[1] + before.axes[2][k] * l[2])
  return (p[0] - was[0]) * -n[1] + (p[1] - was[2]) * n[0]
}

/** Side by side, rather than one on the other: their heights overlap. */
const level = (a: Blk, b: Blk) => Math.min(a.y + a.half[1], b.y + b.half[1]) - Math.max(a.y - a.half[1], b.y - b.half[1]) > 0.001

/** Two blocks side by side and in each other: the floor's axes between them (each with its gap), else null. */
function besideIn(a: Blk, b: Blk, tol = TOL): Axis[] | null {
  if (!level(a, b)) return null
  const A = blockBox(a), B = blockBox(b)
  if (far(A, B)) return null
  const ax = axes(A, B).filter((x) => Math.abs(x.L[1]) < 0.01)
  return ax.length && ax.every((x) => x.gap <= -tol) ? ax : null
}

/** Block `a` pushes block `b` (beside it) out of it, along the floor. Returns whether it had to. */
function pushOn(a: Blk, b: Blk, tol = TOL): boolean {
  const ax = besideIn(a, b, tol)
  if (!ax) return false
  const best = ax.reduce((m, x) => (x.gap > m.gap ? x : m))
  const h = Math.hypot(best.L[0], best.L[2])
  shove(b, [best.L[0] / h, best.L[2] / h], -best.gap / h + MARGIN, contact(blockBox(a), blockBox(b), ax).at)
  return true
}

/** The point of a block's footprint nearest (x, z), on the floor. */
function nearestOn(b: Blk, x: number, z: number): [number, number] {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw)
  const dx = x - b.x, dz = z - b.z
  const u = Math.max(-b.half[0], Math.min(b.half[0], dx * c - dz * s))
  const v = Math.max(-b.half[2], Math.min(b.half[2], dx * s + dz * c))
  return [b.x + u * c + v * s, b.z - u * s + v * c]
}

/** Keep a block out of an arm's base. Returns whether it had to move. */
function outOfBase(b: Blk, base: Base, tol = TOL): boolean {
  let moved = false
  for (const [r, y0, y1] of COLUMN) {
    if (b.y + b.half[1] <= y0 + 1e-9 || b.y - b.half[1] >= y1 - 1e-9) continue
    const [px, pz] = nearestOn(b, base.x, base.z)
    const dx = px - base.x, dz = pz - base.z, d = Math.hypot(dx, dz)
    if (d >= r - tol) continue
    if (d > 1e-9) shove(b, [dx / d, dz / d], r - d + MARGIN, [px, pz])
    else {
      // Its middle over the column's axis (it can't get there, but just in case): straight out.
      const ox = b.x - base.x, oz = b.z - base.z, o = Math.hypot(ox, oz) || 1
      b.x = base.x + (ox / o) * (r + Math.hypot(b.half[0], b.half[2]))
      b.z = base.z + (oz / o) * (r + Math.hypot(b.half[0], b.half[2]))
    }
    moved = true
  }
  return moved
}

/** Where a block and a base's column overlap (for checks): how far in, or 0. */
function inBase(b: Blk, base: Base): number {
  let most = 0
  for (const [r, y0, y1] of COLUMN) {
    if (b.y + b.half[1] <= y0 + 1e-9 || b.y - b.half[1] >= y1 - 1e-9) continue
    const [px, pz] = nearestOn(b, base.x, base.z)
    most = Math.max(most, r - Math.hypot(px - base.x, pz - base.z))
  }
  return most
}

export type Settled = 'ok' | 'on' | 'pinned'

/**
 * Get the blocks out of the arms' parts: `movers`, the parts of the arm that's moving (`before`: the same parts a step
 * ago, for their grip to drag what they push), and `still`, everything else (other arms, what they hold). A block a
 * part runs into is pushed along the floor, pushes the blocks it runs into, and is kept out of the bases. A mover coming
 * down on a block is 'on' it, for the arm to stop, unless the arm is `real` (then the block is pushed out from under
 * it); something still resting on a block is left be. 'pinned': some block couldn't get clear. Overlap up to `tol` is
 * touching. Changes `blocks` in place.
 */
export function settle(blocks: Blk[], movers: Box[], still: Box[], bases: Base[], real = false, tol = TOL, before?: Box[]): Settled {
  for (let round = 0; round <= ROUNDS; round++) {
    // The last round only checks: anything still in anything is pinned.
    const check = round === ROUNDS
    let moved = false
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      for (let m = 0; m < movers.length + still.length; m++) {
        const mover = m < movers.length
        const p = mover ? movers[m] : still[m - movers.length]
        const B = blockBox(b)
        if (far(p, B)) continue
        const ax = axes(p, B)
        if (ax.some((x) => x.gap > -tol)) continue
        const c = contact(p, B, ax)
        if (c.lift < c.dist && !(mover && real)) {
          if (mover) return 'on'
          continue
        }
        if (check) return 'pinned'
        // A moving part's grip drags the block along with it (once a step; after that, only out of it).
        const drag = mover && round === 0 && before?.[m] ? dragOf(p, before[m], c.at, b.y, c.n) : 0
        shove(b, c.n, c.dist + MARGIN, c.at, drag, drag ? GRIP : 0)
        moved = true
      }
      for (const base of bases) {
        if (check ? inBase(b, base) > tol : outOfBase(b, base, tol)) {
          if (check) return 'pinned'
          moved = true
        }
      }
      for (let j = 0; j < blocks.length; j++) {
        if (j === i) continue
        if (check ? besideIn(b, blocks[j], tol) : pushOn(b, blocks[j], tol)) {
          if (check) return 'pinned'
          moved = true
        }
      }
    }
    if (!moved) return 'ok'
  }
  return 'ok'
}

/** Whether a block is clear of the parts, the bases and the other blocks (all but `self`). */
function clearOf(b: Blk, parts: Box[], bases: Base[], blocks: Blk[], self: number) {
  const B = blockBox(b)
  return parts.every((p) => far(p, B) || gap(p, B) > -TOL)
    && bases.every((base) => inBase(b, base) <= TOL)
    && blocks.every((o, j) => j === self || !besideIn(o, b))
}

/** Blocks a real arm has pinned go to the nearest spots on the floor clear of everything (moved in place). */
export function eject(blocks: Blk[], parts: Box[], bases: Base[]) {
  blocks.forEach((b, i) => {
    if (clearOf(b, parts, bases, blocks, i)) return
    for (let d = 0.01; d <= 0.6; d += 0.01) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * 2 * Math.PI
        const t = { ...b, x: b.x + d * Math.cos(a), z: b.z + d * Math.sin(a) }
        if (clearOf(t, parts, bases, blocks, i)) { b.x = t.x; b.z = t.z; return }
      }
    }
  })
}

// ---- the fingers closing on a block ----

/**
 * A block between the fingers (the grasp frame `g`, in the world) as they close from opening `from` to `to`: kept
 * between them, pushed to their middle by the finger that reaches it first, and, too wide across them where it is,
 * turned toward square to them, the way that narrows it, until it fits. Once it's square and still too wide, the
 * fingers stop on its faces: held, at the opening they stopped at. Null when it isn't between them, or when they close
 * too steeply for it to turn on the floor (it's pushed like anything else then).
 */
export function squeeze(b: Blk, g: Frame, from: number, to: number): { b: Blk; open: number; held: boolean } | null {
  const by = byFingers(boxInto(g, blockBox(b)))
  if (!by || Math.abs(by.x) >= fingerAt(from)) return null
  const x = col(g.R, 0), m = Math.hypot(x[0], x[2])
  if (m < 0.3) return null
  const widthAt = (turn: number) => extent(blockBox({ ...b, yaw: b.yaw + turn }), x)
  /** The block moved along the floor, the way the fingers close, to within `half` of their middle. */
  const within = (t: Blk, h: number, half: number): Blk => {
    const xc = dot(sub([t.x, t.y, t.z], g.t), x)
    const room = Math.max(0, half - h)
    const d = (Math.max(-room, Math.min(room, xc)) - xc) / m
    return { ...t, x: t.x + (x[0] / m) * d, z: t.z + (x[2] / m) * d }
  }
  const g1 = fingerAt(to)
  const h0 = widthAt(0)
  if (h0 <= g1) return { b: within(b, h0, g1), open: to, held: false }
  // Too wide across them: which way it turns narrower, and how far to square (its sides along or across the grip).
  const e = 1e-4
  const hp = widthAt(e), hn = widthAt(-e)
  let turn = 0
  if (Math.min(hp, hn) < h0 - 1e-12) {
    const q = Math.PI / 2
    const up = ((((-Math.atan2(x[2], x[0]) - b.yaw) % q) + q) % q)
    turn = hp <= hn ? up : up - q
  }
  const hMin = widthAt(turn)
  if (hMin <= g1) {
    // Turn it just as far as the fingers make it.
    let lo = 0, hi = 1
    for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (widthAt(turn * mid) <= g1) hi = mid; else lo = mid }
    const t = { ...b, yaw: b.yaw + turn * hi }
    return { b: within(t, widthAt(turn * hi), g1), open: to, held: false }
  }
  const t = { ...b, yaw: b.yaw + turn }
  return { b: within(t, hMin, hMin), open: Math.min(from, openingFor(hMin)), held: true }
}

// ---- an arm's step among the blocks ----

const KEYS = ['yaw', 'shoulder', 'elbow', 'wrist', 'roll'] as const
type ArmKey = (typeof KEYS)[number]
/** Every set of the arm's joints, fewest first. */
const SETS: ArmKey[][] = Array.from({ length: 31 }, (_, n) => KEYS.filter((_, i) => ((n + 1) >> i) & 1)).sort((a, b) => a.length - b.length)

export interface Among { blocks: Blk[]; still: Box[]; bases: Base[] }
/**
 * How the arm moves: `real`, a real arm (nothing virtual may stop it); `following`, headed for a pose (the floor lets it
 * ride along, ./kinematics.ts); `minShoulder`, how far back its shoulder goes (degrees).
 */
export interface How { real: boolean; following: boolean; minShoulder: number }
export interface Stepped {
  pose: ArmPose
  open: number
  /** The joints a block stopped. */
  stopped: Key[]
  /** The block (by index) the fingers closed on and now hold, where it sits in the grasp frame. */
  took: { i: number; box: Box } | null
  blocks: Blk[]
}

const copy = (bl: Blk[]) => bl.map((b) => ({ ...b }))
const mix = (from: ArmPose, to: ArmPose, keys: readonly ArmKey[], f: number): ArmPose => {
  const p = { ...to }
  for (const k of keys) p[k] = from[k] + (to[k] - from[k]) * f
  return p
}

/**
 * One frame of an arm among the blocks, from its pose and opening `from` toward `to` (each joint having moved at its
 * own pace, under its caps), in steps small enough that nothing slips through anything; `held` is the block it holds,
 * in its grasp frame. Blocks in the way are pushed. One that can't be (under a part coming down on it, or pinned)
 * stops the fewest joints that keep every part out of it, and the floor under it, as near as they can get. A block
 * squeezed between the fingers stops them on its faces, held. Each step keeps the arm, and what it holds, above the
 * floor as the frame does. A real arm is never stopped: what it runs into is pushed out of its way, however far that
 * takes.
 */
export function stepAmong(s: Stand, from: { pose: ArmPose; open: number }, to: { pose: ArmPose; open: number }, held: Box | null, world: Among, how: How): Stepped {
  const real = how.real
  let blocks = copy(world.blocks)
  let h = held
  const partsAt = (p: ArmPose, o: number) => armParts(s, p, o, h)
  // How far any part moves, and whether any comes near a block: most frames, none does.
  const A = partsAt(from.pose, from.open), Z = partsAt(to.pose, to.open)
  let move = 0
  A.forEach((a, i) => { const ca = corners(a), cz = corners(Z[i]); ca.forEach((c, k) => { move = Math.max(move, len(sub(cz[k], c))) }) })
  const near = (b: Blk) => { const B = blockBox(b), r = len(B.half) + move + 0.01; return A.some((a, i) => len(sub(a.c, B.c)) < len(a.half) + r || len(sub(Z[i].c, B.c)) < len(a.half) + r) }
  if (!blocks.some(near)) return { pose: { ...to.pose }, open: to.open, stopped: [], took: null, blocks }
  const n = Math.min(MAX_SUB, Math.max(1, Math.ceil(move / SUB)))

  let q = { ...from.pose }, u = from.open
  const stopped = new Set<Key>()
  let took: Stepped['took'] = null
  const free = () => blocks.filter((_, i) => i !== took?.i)
  /**
   * The blocks settled around the arm at `p`, `o` (a copy), or null if that can't be. Where a block stops the arm, it
   * stops touching it more closely than touching counts (`tol`), so that it's clear by that much when it starts again.
   */
  const tryAt = (p: ArmPose, o: number, tol = TOL): Blk[] | null => {
    const t = copy(blocks)
    const r = settle(t.filter((_, i) => i !== took?.i), partsAt(p, o), world.still, world.bases, real, tol, partsAt(q, u))
    if (r === 'ok') return t
    if (!real) return null
    eject(t.filter((_, i) => i !== took?.i), [...partsAt(p, o), ...world.still], world.bases)
    return t
  }
  /** Stop the fewest joints that keep the arm out of the blocks (and above the floor), as near `want` as they get. */
  const holdBack = (want: ArmPose) => {
    const floor = Math.min(FLOOR_CLEAR, lowest(q, h)) - 1e-9
    const ok = (p: ArmPose) => (lowest(p, h) < floor ? null : tryAt(p, u, TOL / 4))
    const moved = (set: ArmKey[]) => set.reduce((sum, k) => sum + Math.abs(want[k] - q[k]), 0)
    const sets = [...SETS].sort((a, b) => a.length - b.length || moved(b) - moved(a))
    for (const set of sets) {
      let bl = ok(mix(q, want, set, 0))
      if (!bl) continue
      let lo = 0, hi = 1
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2
        const b2 = ok(mix(q, want, set, mid))
        if (b2) { lo = mid; bl = b2 } else hi = mid
      }
      return { pose: mix(q, want, set, lo), keys: set, blocks: bl }
    }
    // Nothing does it (something else moved a block into the arm): the arm stays, and the blocks make way.
    const t = copy(blocks)
    eject(t.filter((_, i) => i !== took?.i), [...partsAt(q, u), ...world.still], world.bases)
    return { pose: { ...q }, keys: [...KEYS], blocks: t }
  }

  for (let k = 1; k <= n; k++) {
    const f = k / n
    // The arm moves, its fingers as they were.
    let want = { ...q }
    for (const key of KEYS) if (!stopped.has(key)) want[key] = from.pose[key] + (to.pose[key] - from.pose[key]) * f
    if (!real) want = stepAboveFloor(q, want, how.following, how.minShoulder, h).pose
    const got = tryAt(want, u)
    if (got) { q = want; blocks = got } else {
      const b = holdBack(want)
      for (const key of b.keys) stopped.add(key)
      q = b.pose
      blocks = b.blocks
    }
    // The fingers move.
    if (stopped.has('grip') || took) continue
    const o = from.open + (to.open - from.open) * f
    if (o === u) continue
    if (o < u && !real) {
      const g = armFrames(s, q).grasp
      const between = free().map((b) => ({ b, i: blocks.indexOf(b) })).map(({ b, i }) => ({ i, sq: squeeze(b, g, u, o), d: len(sub([b.x, b.y, b.z], g.t)) }))
        .filter((x) => x.sq).sort((p, r) => p.d - r.d)[0]
      if (between?.sq) {
        const t = copy(blocks)
        t[between.i] = between.sq.b
        if (settle(t.filter((_, i) => i !== took?.i), partsAt(q, between.sq.open), world.still, world.bases) !== 'ok') { stopped.add('grip'); continue }
        blocks = t
        u = between.sq.open
        if (between.sq.held) {
          took = { i: between.i, box: boxInto(g, blockBox(blocks[between.i])) }
          h = took.box
          stopped.add('grip')
        }
        continue
      }
    }
    // Nothing between them (or opening): they push what they run into, beside them.
    const got2 = tryAt(q, o)
    if (got2) { u = o; blocks = got2; continue }
    let lo = 0, hi = 1, bl = blocks
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2
      const b2 = tryAt(q, u + (o - u) * mid, TOL / 4)
      if (b2) { lo = mid; bl = b2 } else hi = mid
    }
    u += (o - u) * lo
    blocks = bl
    stopped.add('grip')
  }
  return { pose: q, open: u, stopped: [...stopped], took, blocks }
}

// ---- blocks coming to rest ----

/**
 * Where a free block comes to rest: on the highest block under it that its middle is over, else on the floor. One
 * whose middle is past the edge of a block it overlaps slides off that block first. Returns its middle at rest.
 */
export function restOf(b: Blk, others: Blk[]): { x: number; y: number; z: number } {
  let t = { ...b }
  let top = 0
  for (let pass = 0; pass < 4; pass++) {
    top = 0
    let slid = false
    for (const o of others) {
      // Under it: its top no higher than this one's middle.
      if (o.y + o.half[1] > t.y + 1e-9) continue
      const O = blockBox(o), T = blockBox(t)
      const ax = axes(O, T).filter((x) => Math.abs(x.L[1]) < 0.01)
      if (!ax.length || ax.some((x) => x.gap > -TOL)) continue
      const [px, pz] = nearestOn(o, t.x, t.z)
      if (Math.hypot(px - t.x, pz - t.z) < 1e-9) { top = Math.max(top, o.y + o.half[1]); continue }
      // Its middle is past that block's edge: it slides off.
      const best = ax.reduce((m, x) => (x.gap > m.gap ? x : m))
      const hh = Math.hypot(best.L[0], best.L[2])
      t = { ...t, x: t.x + (best.L[0] / hh) * (-best.gap / hh + MARGIN), z: t.z + (best.L[2] / hh) * (-best.gap / hh + MARGIN) }
      slid = true
    }
    if (!slid) break
  }
  return { x: t.x, y: top + b.half[1], z: t.z }
}
