/**
 * The home page's Play scene (./scenes.ts) as motion: four pucks guard the sides of a field and keep a ball in play,
 * yours anywhere you point. Pure, unit-tested in node, so it can be held to its rule: play never stops.
 *   - The field's corners are round, as it's drawn, so the ball can't wedge into one.
 *   - A ball squeezed between a puck and the edge squirts out along the edge, the way a real one does.
 *   - A guard that hits the ball backs away from it for a moment rather than pressing it, and never leans in on a ball
 *     that's behind it (between it and its edge).
 *   - A ball that has hardly moved for a moment and a half is sent back toward the middle.
 * Units are the scene's (its viewBox), y down.
 */

export interface Pt { x: number; y: number }

/** The field, and how round its corners are. */
export const FIELD = { L: 70, R: 330, T: 34, B: 226, round: 22 } as const
export const MIDDLE: Pt = { x: (FIELD.L + FIELD.R) / 2, y: (FIELD.T + FIELD.B) / 2 }
export const BALL_R = 6.5
export const PUCK_R = 12
/** How far inside the field's edge the ball's centre and a puck's stay. */
const BALL_IN = 8
const PUCK_IN = 14
/** A ball and a puck touch with their centres this close. */
const TOUCH = 18.5
/** The ball's speed (units a second): lively, never wild. */
const SLOWEST = 130
const FASTEST = 230
/** How long a guard that hit the ball backs away from it (s). */
const BACK_OFF = 0.5
/** A ball that stays this close to one spot for this long (s) is sent back toward the middle. */
export const STILL_R = 18
export const STILL_S = 1.5
/** Steps no longer than this (s), so nothing passes through anything. */
const STEP = 1 / 120

export type Side = 'bottom' | 'top' | 'left' | 'right'
export interface Puck { x: number; y: number; vx: number; vy: number; side: Side; home: Pt; rest: number; touching: boolean }
export interface Rally {
  x: number; y: number; vx: number; vy: number
  pucks: Puck[]
  /** Seconds played; hits of the ball by a puck, and times it was sent back toward the middle. */
  t: number
  contacts: number
  nudges: number
  /** Where the ball has stayed near since when. */
  anchor: { x: number; y: number; t: number }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Each player guards a side: bottom (you), top, left, right. */
const SIDES: [Side, Pt][] = [
  ['bottom', { x: MIDDLE.x, y: FIELD.B - 22 }], ['top', { x: MIDDLE.x, y: FIELD.T + 22 }],
  ['left', { x: FIELD.L + 22, y: MIDDLE.y }], ['right', { x: FIELD.R - 22, y: MIDDLE.y }],
]

export function rally(): Rally {
  return {
    x: MIDDLE.x, y: MIDDLE.y, vx: 120, vy: 85,
    pucks: SIDES.map(([side, home]) => ({ x: home.x, y: home.y, vx: 0, vy: 0, side, home, rest: 0, touching: false })),
    t: 0, contacts: 0, nudges: 0, anchor: { x: MIDDLE.x, y: MIDDLE.y, t: 0 },
  }
}

/**
 * Keep a point `q` (changed in place) inside the field, `inset` in from its edge, the corners rounded as the field's
 * are. Where it was out, returns the edge's inward normal there; else null.
 */
export function keepIn(q: Pt, inset: number): Pt | null {
  const r = Math.max(0, FIELD.round - inset)
  const cx = clamp(q.x, FIELD.L + inset + r, FIELD.R - inset - r), cy = clamp(q.y, FIELD.T + inset + r, FIELD.B - inset - r)
  const dx = q.x - cx, dy = q.y - cy, d = Math.hypot(dx, dy)
  if (d <= r + 1e-9) return null
  q.x = cx + (dx / d) * r
  q.y = cy + (dy / d) * r
  return { x: -dx / d, y: -dy / d }
}

/** Where a guard heads: along its side with the ball, leaning in on a ball in front of it, backing away after a hit. */
function guardGoal(pk: Puck, ball: Pt): Pt {
  const across = pk.side === 'bottom' || pk.side === 'top' ? 'y' : 'x'
  const along = across === 'y' ? 'x' : 'y'
  // Which way the field is from its line, across it.
  const inward = pk.side === 'bottom' || pk.side === 'right' ? -1 : 1
  if (pk.rest > 0) {
    // Back away from the ball, toward the middle of its own line.
    const dx = pk.x - ball.x, dy = pk.y - ball.y, d = Math.hypot(dx, dy) || 1
    return { x: pk.x + (dx / d) * 30 + (pk.home.x - pk.x) * 0.3, y: pk.y + (dy / d) * 30 + (pk.home.y - pk.y) * 0.3 }
  }
  const lo = (along === 'x' ? FIELD.L : FIELD.T) + 30, hi = (along === 'x' ? FIELD.R : FIELD.B) - 30
  const off = (ball[across] - pk.home[across]) * inward
  const g: Pt = { x: 0, y: 0 }
  if (off >= 0) {
    // In front of its line: follow it along the side, and lean in when it's close.
    g[along] = clamp(ball[along], lo, hi)
    g[across] = pk.home[across] + (off < 70 ? (ball[across] - pk.home[across]) * 0.4 : 0)
  } else {
    // Behind its line (between it and the edge): stand beside it on the line, never on top of it, and let it out.
    const side = ball[along] < MIDDLE[along] ? 1 : -1
    g[along] = clamp(ball[along] + side * (TOUCH + 8), lo, hi)
    g[across] = pk.home[across]
  }
  return g
}

/** A frame of `dt` seconds, with your pointer at `p` (null: your puck guards its side too). Changes `r` in place. */
export function stepRally(r: Rally, dt: number, p: Pt | null) {
  const n = Math.max(1, Math.ceil(dt / STEP))
  for (let i = 0; i < n; i++) step(r, dt / n, p)
}

function step(r: Rally, dt: number, p: Pt | null) {
  r.t += dt
  // The ball rolls, and comes off the edge (a round corner sends it back out of the corner).
  r.x += r.vx * dt
  r.y += r.vy * dt
  bounce(r)
  for (const pk of r.pucks) {
    const mine = pk.side === 'bottom' && !!p
    const g = mine ? { ...p! } : guardGoal(pk, r)
    keepIn(g, PUCK_IN)
    const ox = pk.x, oy = pk.y
    const k = 1 - Math.exp(-dt * (mine ? 14 : 5))
    pk.x += (g.x - pk.x) * k
    pk.y += (g.y - pk.y) * k
    pk.rest = Math.max(0, pk.rest - dt)
    // Pucks don't pass through each other: yours, going anywhere, nudges the others aside.
    for (const o of r.pucks) {
      if (o === pk) continue
      const dx = pk.x - o.x, dy = pk.y - o.y, d = Math.hypot(dx, dy)
      if (d >= 2 * PUCK_R || d < 1e-6) continue
      const push = (2 * PUCK_R - d) / 2
      pk.x += (dx / d) * push; pk.y += (dy / d) * push
      o.x -= (dx / d) * push; o.y -= (dy / d) * push
      keepIn(pk, PUCK_IN)
      keepIn(o, PUCK_IN)
    }
    pk.vx = (pk.x - ox) / dt
    pk.vy = (pk.y - oy) / dt
    hit(r, pk, mine)
  }
  // Whatever pushed it last, the ball stays on the field.
  bounce(r)
  // Keep it lively but never wild.
  const sp = Math.hypot(r.vx, r.vy) || 1, want = clamp(sp, SLOWEST, FASTEST)
  r.vx *= want / sp
  r.vy *= want / sp
  // Still for a while (pinned, or rattling in one spot): back toward the middle, with the guards near it backing off.
  if (Math.hypot(r.x - r.anchor.x, r.y - r.anchor.y) > STILL_R) r.anchor = { x: r.x, y: r.y, t: r.t }
  else if (r.t - r.anchor.t > STILL_S) nudge(r)
}

/** The ball off the field's edge: back inside it, heading in. Returns the edge's inward normal where it was out. */
function bounce(r: Rally): Pt | null {
  const n = keepIn(r, BALL_IN)
  if (!n) return null
  const d = r.vx * n.x + r.vy * n.y
  if (d < 0) { r.vx -= 2 * d * n.x; r.vy -= 2 * d * n.y }
  return n
}

/** The ball against a puck: it bounces off, taking some of the puck's speed; squeezed against the edge, it squirts out along it. */
function hit(r: Rally, pk: Puck, mine: boolean) {
  let dx = r.x - pk.x, dy = r.y - pk.y, d = Math.hypot(dx, dy)
  if (d >= TOUCH) { pk.touching = false; return }
  if (d < 1e-6) { dx = MIDDLE.x - pk.x; dy = MIDDLE.y - pk.y; d = Math.hypot(dx, dy) || 1 }
  const nx = dx / d, ny = dy / d
  const dot = r.vx * nx + r.vy * ny
  if (dot < 0) { r.vx -= 2 * dot * nx; r.vy -= 2 * dot * ny }
  r.vx += pk.vx * 0.25
  r.vy += pk.vy * 0.25
  r.x = pk.x + nx * (TOUCH + 0.1)
  r.y = pk.y + ny * (TOUCH + 0.1)
  // Pressed out past the edge: along the edge, away from the puck, until it's clear of it.
  for (let i = 0; i < 3; i++) {
    const m = bounce(r)
    if (!m) break
    const tx = -m.y, ty = m.x
    const wx = r.x - pk.x, wy = r.y - pk.y
    const h = wx * m.x + wy * m.y
    let a = wx * tx + wy * ty
    const s = Math.abs(a) > 1e-6 ? Math.sign(a) : Math.sign((MIDDLE.x - r.x) * tx + (MIDDLE.y - r.y) * ty) || 1
    a = Math.abs(a)
    const need = Math.sqrt(Math.max(0, TOUCH * TOUCH - h * h)) + 0.1
    if (a >= need) break
    r.x += s * tx * (need - a)
    r.y += s * ty * (need - a)
    const sp = Math.max(170, Math.hypot(r.vx, r.vy))
    r.vx = s * tx * sp + m.x * 30
    r.vy = s * ty * sp + m.y * 30
  }
  bounce(r)
  if (!pk.touching) {
    r.contacts++
    if (!mine) pk.rest = BACK_OFF
  }
  pk.touching = true
}

/** Send the ball back toward the middle (a little to one side or the other, turn about), clear of the pucks. */
function nudge(r: Rally) {
  const dx = MIDDLE.x - r.x, dy = MIDDLE.y - r.y
  const a = Math.atan2(dy, dx) + (r.nudges % 2 ? 0.35 : -0.35)
  r.vx = Math.cos(a) * 190
  r.vy = Math.sin(a) * 190
  for (const pk of r.pucks) {
    const d = Math.hypot(r.x - pk.x, r.y - pk.y)
    if (d < 60) pk.rest = BACK_OFF
    if (d < TOUCH + 0.1) {
      // Out of the puck, toward the middle.
      const m = Math.hypot(dx, dy) || 1
      r.x += (dx / m) * (TOUCH + 0.1 - d)
      r.y += (dy / m) * (TOUCH + 0.1 - d)
    }
  }
  r.nudges++
  r.anchor = { x: r.x, y: r.y, t: r.t }
}
