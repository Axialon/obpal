/**
 * A ribbon of light on a stick, like a gymnast's: the tip goes where the controller points and the rest trails it
 * with a little weight, twisting as it flows. A chain of points (Verlet: each keeps its own momentum, then the links
 * pull it back to length) drawn as a band whose width is its twist, so it shows a lit face and a darker back.
 * Plain 2D canvas: one glow stroke and one quad per link, no filters.
 */

export type RGB = readonly [number, number, number]
export interface RibbonLook {
  /** The lit face, and the white-hot highlight it turns to when facing you squarely. */
  face: RGB
  core: RGB
  /** The back of the band, and the haze around it. */
  back: RGB
  haze: RGB
}

/** A point on the ribbon's path is this far behind the one before it, in units of the ribbon's width. */
const LINK = 0.62
const TAU = Math.PI * 2
/** The ribbon rolls with the stick's turns (radians of twist per radian turned), and drifts slowly while lit. */
const ROLL = 0.5
const DRIFT = 0.3

export interface StepOptions {
  /** How quickly the stick catches up with its target, per second. */
  follow: number
  /** Lit while something moves it; at rest it fades and turns its lit face to you. */
  lit: boolean
  /** How much of each link's speed it keeps per 60th of a second: lower traces the stick's path more exactly. */
  keep?: number
  /** Downward pull, in widths per second squared. 0 (the default): it keeps the shape its path gave it. */
  sag?: number
}

export class Ribbon {
  readonly n: number
  /** Positions now and one step ago (Verlet), and each point's twist, in radians. */
  private readonly x: Float64Array
  private readonly y: Float64Array
  private readonly px: Float64Array
  private readonly py: Float64Array
  private readonly twist: Float64Array
  /** 0 hidden … 1 fully lit. Fades in as the ribbon moves and out as it rests. */
  life = 0
  /** How fast the tip moved lately, in widths per second (smoothed). */
  speed = 0
  private spin = 0
  private heading: number | null = null

  constructor(n = 40, public width = 22) {
    this.n = n
    this.x = new Float64Array(n); this.y = new Float64Array(n)
    this.px = new Float64Array(n); this.py = new Float64Array(n)
    this.twist = new Float64Array(n)
  }

  get tipX() { return this.x[0] }
  get tipY() { return this.y[0] }

  /** The box the ribbon covers, in CSS px, with room for its haze and the light at its stick. */
  bounds(): [number, number, number, number] {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i < this.n; i++) {
      const x = this.x[i], y = this.y[i]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    const pad = this.width * 2.6
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad]
  }

  /** Gather the whole ribbon at one point, at rest. */
  reset(x: number, y: number) {
    this.x.fill(x); this.px.fill(x)
    this.y.fill(y); this.py.fill(y)
    this.speed = 0
    this.heading = null
  }

  /**
   * Move the tip toward (tx, ty) and let the rest follow (see StepOptions). Returns whether anything still moves (or
   * fades) enough to be worth drawing again.
   */
  step(dt: number, tx: number, ty: number, o: StepOptions): boolean {
    const { n, x, y, px, py, twist } = this
    const w = this.width
    const lit = o.lit
    dt = Math.min(dt, 1 / 30)
    const k = 1 - Math.exp(-dt * o.follow)
    const ox = x[0], oy = y[0]
    x[0] += (tx - x[0]) * k
    y[0] += (ty - y[0]) * k
    px[0] = ox; py[0] = oy
    const v = Math.hypot(x[0] - ox, y[0] - oy) / Math.max(dt, 1e-4) / w
    this.speed += (v - this.speed) * (1 - Math.exp(-dt * 6))

    // Each link keeps some of its momentum (and weight, if asked).
    const keep = Math.pow(o.keep ?? 0.86, dt * 60)
    const sag = (o.sag ?? 0) * w * dt * dt
    let moving = this.speed > 0.05
    for (let i = 1; i < n; i++) {
      const vx = (x[i] - px[i]) * keep, vy = (y[i] - py[i]) * keep
      px[i] = x[i]; py[i] = y[i]
      x[i] += vx; y[i] += vy + sag
    }
    // Links pull back to length (a rope: they may go slack, never stretch).
    const L = LINK * w
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < n; i++) {
        const dx = x[i] - x[i - 1], dy = y[i] - y[i - 1]
        const d = Math.hypot(dx, dy)
        if (d > L) { const s = L / d; x[i] = x[i - 1] + dx * s; y[i] = y[i - 1] + dy * s }
      }
    }
    for (let i = 1; i < n; i++) if (Math.abs(x[i] - px[i]) + Math.abs(y[i] - py[i]) > 0.02 * w) { moving = true; break }

    // The twist starts at the stick and travels down the ribbon. It rolls as the stick turns (a loop rolls it one way,
    // the next bend the other) and drifts slowly while lit; at rest it turns its lit face to you.
    const mx = x[0] - ox, my = y[0] - oy
    if (Math.hypot(mx, my) > 0.02 * w) {
      const h = Math.atan2(my, mx)
      if (this.heading !== null) {
        let d = h - this.heading
        if (d > Math.PI) d -= TAU
        else if (d < -Math.PI) d += TAU
        this.spin += d * ROLL
      }
      this.heading = h
    }
    if (lit) this.spin += dt * DRIFT
    else {
      const face = Math.round(this.spin / TAU) * TAU
      this.spin += (face - this.spin) * (1 - Math.exp(-dt * 2.5))
      if (Math.abs(face - this.spin) > 0.01) moving = true
    }
    twist[0] = this.spin
    const pass = 1 - Math.exp(-dt * 22)
    for (let i = n - 1; i > 0; i--) twist[i] += (twist[i - 1] - twist[i]) * pass
    if (Math.abs(twist[n - 1] - twist[0]) > 0.02) moving = true

    const goal = lit ? 1 : 0
    this.life += (goal - this.life) * (1 - Math.exp(-dt * (lit ? 3 : 1.4)))
    return moving || Math.abs(goal - this.life) > 0.01
  }

  /** Draw at `scale` device pixels per CSS pixel, at `alpha` (by default its own light; a resting ribbon may keep some). */
  draw(g: CanvasRenderingContext2D, look: RibbonLook, scale: number, alpha = this.life) {
    const { n, x, y, twist } = this
    const a = alpha
    if (a < 0.01) return
    const w = this.width * scale
    const X = (i: number) => x[i] * scale, Y = (i: number) => y[i] * scale
    const rgba = (c: RGB, o: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${o.toFixed(3)})`

    // The haze: the path, wide and faint, added onto whatever is behind.
    g.save()
    g.globalCompositeOperation = 'lighter'
    g.lineCap = 'round'; g.lineJoin = 'round'
    for (const [wide, c, o] of [[1.9, look.haze, 0.05], [0.8, look.face, 0.08]] as const) {
      g.beginPath()
      g.moveTo(X(0), Y(0))
      for (let i = 1; i < n - 1; i++) g.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2)
      g.lineWidth = w * wide
      g.strokeStyle = rgba(c, o * a)
      g.stroke()
    }
    g.restore()

    // The band: one quad per link, its width the cosine of its twist; tail first so the tip is on top.
    let lx = 0, ly = 0, rx = 0, ry = 0
    for (let i = n - 1; i >= 0; i--) {
      const j = Math.max(0, i - 1), k = Math.min(n - 1, i + 1)
      let tx = x[j] - x[k], ty = y[j] - y[k]
      const tl = Math.hypot(tx, ty) || 1
      tx /= tl; ty /= tl
      const along = i / (n - 1)
      // Full width a little behind the stick, thinning to a point at the tail.
      const taper = Math.min(1, (i + 1) / 4) * Math.pow(1 - along, 0.75)
      const c = Math.cos(twist[i])
      const half = (w / 2) * taper * c
      const nlx = X(i) - ty * half, nly = Y(i) + tx * half
      const nrx = X(i) + ty * half, nry = Y(i) - tx * half
      if (i < n - 1) {
        const lit = Math.abs(c)
        const face = c >= 0
        const o = a * (0.28 + 0.72 * Math.pow(1 - along, 0.6))
        // The lit face cools from the stick's colour to the haze toward the tail, like a trail of light.
        const cool = Math.pow(along, 0.9) * 0.85
        const base: RGB = face ? [look.face[0] + (look.haze[0] - look.face[0]) * cool, look.face[1] + (look.haze[1] - look.face[1]) * cool, look.face[2] + (look.haze[2] - look.face[2]) * cool] : look.back
        const hot = face ? look.core : look.haze
        const m = Math.pow(lit, 6) * (face ? 0.85 : 0.35)
        g.beginPath()
        g.moveTo(nlx, nly); g.lineTo(lx, ly); g.lineTo(rx, ry); g.lineTo(nrx, nry)
        g.closePath()
        g.fillStyle = rgba([base[0] + (hot[0] - base[0]) * m, base[1] + (hot[1] - base[1]) * m, base[2] + (hot[2] - base[2]) * m], o * (face ? 1 : 0.8))
        g.fill()
      }
      lx = nlx; ly = nly; rx = nrx; ry = nry
    }
  }
}

/** A soft round light, drawn once and stamped where a ribbon's stick is. */
export function glowSprite(c: RGB, core: RGB, size = 96): HTMLCanvasElement {
  const s = document.createElement('canvas')
  s.width = s.height = size
  const g = s.getContext('2d')!
  const r = size / 2
  const grad = g.createRadialGradient(r, r, 0, r, r, r)
  grad.addColorStop(0, `rgba(${core[0]},${core[1]},${core[2]},1)`)
  grad.addColorStop(0.12, `rgba(${core[0]},${core[1]},${core[2]},0.9)`)
  grad.addColorStop(0.3, `rgba(${c[0]},${c[1]},${c[2]},0.45)`)
  grad.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`)
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  return s
}

/** "#38bdf8" → [56, 189, 248]. */
export function hexRgb(hex: string): RGB {
  const v = parseInt(hex.replace('#', ''), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}
