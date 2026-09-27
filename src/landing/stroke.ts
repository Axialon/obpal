/**
 * The hero's flourish as one deliberate stroke. The light comes in from the left, goes once round the headline the way
 * the satellite goes round the logo's ring, then glides along beneath it and lands on its full stop. It is built once
 * per layout as a polyline and walked at an even pace (easing in, and settling at the end), so the motion is the same
 * every time, and smooth.
 */

/** Where the headline is, in the hero's CSS px: the box its text fills, and the full stop that ends it. */
export interface Headline { left: number; right: number; top: number; bottom: number; dot: { x: number; y: number } }

export interface Stroke {
  xs: Float64Array
  ys: Float64Array
  /** Running length at each point. */
  cum: Float64Array
  len: number
  /** Where the last pass beneath the headline begins (a shorter replay starts here). */
  landFrom: number
}

type P = [number, number]
const TAU = Math.PI * 2
/** The ring leans a little, like the logo's. */
const TILT = -0.1

export function orbitStroke(h: Headline, W: number): Stroke {
  const pts: P[] = []
  const cx = (h.left + h.right) / 2, cy = (h.top + h.bottom) / 2
  const pad = Math.max(16, (h.bottom - h.top) * 0.16)
  // The ring clears the headline, and stays on screen.
  const a = Math.max(40, Math.min((h.right - h.left) / 2 + pad, cx - 12, W - cx - 12))
  const b = (h.bottom - h.top) / 2 + pad * 0.75
  const cs = Math.cos(TILT), sn = Math.sin(TILT)
  const ring = (th: number): P => { const ex = a * Math.cos(th), ey = b * Math.sin(th); return [cx + ex * cs - ey * sn, cy + ex * sn + ey * cs] }
  /** Direction of travel on the ring (angle decreasing: along the bottom to the right, up the right side, back over the top). */
  const heading = (th: number): P => {
    const dx = a * Math.sin(th), dy = -b * Math.cos(th)
    const x = dx * cs - dy * sn, y = dx * sn + dy * cs
    const l = Math.hypot(x, y) || 1
    return [x / l, y / l]
  }
  const bezier = (p0: P, p1: P, p2: P, p3: P, n: number) => {
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t
      pts.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ])
    }
  }

  // In from the left, joining the ring low on its left side, already moving along it.
  const th0 = Math.PI / 2 + 0.95
  const join = ring(th0), dj = heading(th0)
  // It starts a little above where it joins, so it comes down into the ring in one sweep.
  const start: P = [-70, join[1] - (h.bottom - h.top) * 0.25]
  pts.push(start)
  bezier(start, [start[0] + Math.max(90, W * 0.1), start[1]], [join[0] - dj[0] * 90, join[1] - dj[1] * 90], join, 40)
  // Once round, and on along the bottom until a glide's length short of the full stop.
  const glide = Math.max(60, Math.min(200, (h.right - h.left) * 0.28))
  const leaveAt = Math.acos(Math.max(-1, Math.min(1, (h.dot.x - glide - cx) / a)))
  const thEnd = Math.min(th0 - 0.3, Math.max(0.25, leaveAt)) - TAU
  const steps = Math.round(220 * (th0 - thEnd) / (TAU + 1.5))
  let landFromIndex = 0
  for (let i = 1; i <= steps; i++) {
    const th = th0 + (thEnd - th0) * (i / steps)
    if (!landFromIndex && th <= th0 - TAU) landFromIndex = pts.length
    pts.push(ring(th))
  }
  // Leave the ring along the way it's going and glide onto the full stop in one arc, arriving the way it approaches.
  const leave = ring(thEnd), dl = heading(thEnd)
  const dist = Math.hypot(h.dot.x - leave[0], h.dot.y - leave[1])
  const c1: P = [leave[0] + dl[0] * dist * 0.4, leave[1] + dl[1] * dist * 0.4]
  const ax = h.dot.x - c1[0], ay = h.dot.y - c1[1], al = Math.hypot(ax, ay) || 1
  bezier(leave, c1, [h.dot.x - (ax / al) * dist * 0.35, h.dot.y - (ay / al) * dist * 0.35], [h.dot.x, h.dot.y], 36)

  const n = pts.length
  const xs = new Float64Array(n), ys = new Float64Array(n), cum = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = pts[i][0]; ys[i] = pts[i][1]
    if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
  }
  return { xs, ys, cum, len: cum[n - 1], landFrom: cum[landFromIndex] }
}

/** The point `s` along the stroke (by length). */
export function pointAt(k: Stroke, s: number): P {
  const n = k.cum.length
  if (s <= 0) return [k.xs[0], k.ys[0]]
  if (s >= k.len) return [k.xs[n - 1], k.ys[n - 1]]
  let lo = 0, hi = n - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k.cum[m] < s) lo = m; else hi = m }
  const t = (s - k.cum[lo]) / (k.cum[hi] - k.cum[lo] || 1)
  return [k.xs[lo] + (k.xs[hi] - k.xs[lo]) * t, k.ys[lo] + (k.ys[hi] - k.ys[lo]) * t]
}

/**
 * How far along (0…1) the walk is at time `u` (0…1): speeding up over the first tenth, even through the middle, and
 * slowing over the last fifth to settle on the full stop. (The integral of a smooth speed profile, normalised.)
 */
export function walk(u: number): number {
  return WALK[Math.round(Math.max(0, Math.min(1, u)) * (WALK.length - 1))]
}
const WALK = (() => {
  const N = 400
  const sm = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }
  const v = Array.from({ length: N + 1 }, (_, i) => { const u = i / N; return sm(0, 0.1, u) * (1 - sm(0.78, 1, u)) + 1e-4 })
  const acc = new Float64Array(N + 1)
  for (let i = 1; i <= N; i++) acc[i] = acc[i - 1] + (v[i] + v[i - 1]) / 2
  for (let i = 0; i <= N; i++) acc[i] /= acc[N]
  return acc
})()

/** How long the walk takes, in seconds: unhurried on any screen (a phone's shorter stroke is not rushed through). */
export const walkTime = (len: number) => Math.max(4.5, Math.min(7, 3.8 + len / 1400))
