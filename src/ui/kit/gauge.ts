/**
 * Instrument gauges. The ring gauge draws a value round an arc, as a solid accent arc on a glass track, or as a ring
 * of dots lit up to the value (a dot-matrix dial); a readout sits in its middle. Made `interactive` it's a dial: an
 * ARIA slider that a finger or mouse turns round its centre, and the keys step. The capsule gauge fills a pill from
 * one end, as a battery or a tank reads. Angles are degrees clockwise from twelve o'clock. The geometry is pure.
 */
import '../../styles/kit.css'

const SVG = 'http://www.w3.org/2000/svg'
const rad = (deg: number) => (deg * Math.PI) / 180

/** The point `r` from (cx, cy) at `deg` degrees clockwise from twelve o'clock. */
export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  return [cx + r * Math.sin(rad(deg)), cy - r * Math.cos(rad(deg))]
}

const n2 = (v: number) => +v.toFixed(2)

/** An SVG path along the circle from `from` to `to` degrees, clockwise; a whole turn is drawn as two halves. */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const sweep = Math.max(0, Math.min(360, to - from))
  if (sweep <= 0) return ''
  if (sweep >= 360) return `${arcPath(cx, cy, r, from, from + 180)} ${arcPath(cx, cy, r, from + 180, from + 360).replace(/^M[^A]*/, '')}`.trim()
  const [x0, y0] = polar(cx, cy, r, from)
  const [x1, y1] = polar(cx, cy, r, from + sweep)
  return `M${n2(x0)} ${n2(y0)} A${n2(r)} ${n2(r)} 0 ${sweep > 180 ? 1 : 0} 1 ${n2(x1)} ${n2(y1)}`
}

/** Where `value` sits on a gauge that sweeps `sweep` degrees from `start`. */
export function angleOf(value: number, min: number, max: number, start: number, sweep: number): number {
  const f = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0
  return start + f * sweep
}

/**
 * The value at `deg` on a gauge that sweeps `sweep` degrees from `start`. An angle in the gap past the ends counts as
 * the nearer end.
 */
export function valueOfAngle(deg: number, min: number, max: number, start: number, sweep: number): number {
  const off = (((deg - start) % 360) + 360) % 360
  let f: number
  if (off <= sweep) f = off / sweep
  else f = off - sweep < 360 - off ? 1 : 0
  return min + f * (max - min)
}

/** How many of `count` dots are lit for a share `f` of the way round. */
export const litDots = (count: number, f: number) => Math.round(Math.max(0, Math.min(1, f)) * count)

export interface RingOptions {
  label: string
  value: number
  min?: number
  max?: number
  /** Degrees clockwise from twelve o'clock where the scale starts, and how far round it goes. */
  start?: number
  sweep?: number
  /** A solid arc, or a ring of dots lit up to the value. */
  kind?: 'arc' | 'dots'
  dots?: number
  /** Its diameter and the ring's thickness, px. */
  size?: number
  thickness?: number
  /** What the middle says for a value (assistive tech reads it too). */
  format?: (value: number) => string
  /** The middle's small caption under the value. */
  caption?: string
  /** A dial: turned by a finger or mouse, stepped by the keys. */
  interactive?: boolean
  step?: number
  onInput?: (value: number) => void
  onChange?: (value: number) => void
}

export class RingGauge {
  readonly el: HTMLDivElement
  private readonly svg: SVGSVGElement
  private readonly track: SVGPathElement
  private readonly fill: SVGPathElement
  private readonly knob: SVGCircleElement
  private readonly dots: SVGCircleElement[] = []
  private readonly out: HTMLSpanElement
  private current: number
  private readonly o: Required<Pick<RingOptions, 'min' | 'max' | 'start' | 'sweep' | 'kind' | 'dots' | 'size' | 'thickness'>>

  constructor(private opts: RingOptions) {
    const sweep = opts.sweep ?? 270
    this.o = { min: opts.min ?? 0, max: opts.max ?? 1, start: opts.start ?? -sweep / 2, sweep, kind: opts.kind ?? 'arc', dots: opts.dots ?? 48, size: opts.size ?? 120, thickness: opts.thickness ?? 8 }
    this.current = opts.value
    const { size, thickness, kind } = this.o
    const el = this.el = document.createElement('div')
    el.className = `kit-ring kit-ring-${kind}`
    el.style.setProperty('--size', `${size}px`)
    const svg = this.svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
    svg.setAttribute('aria-hidden', 'true')
    const c = size / 2, r = c - thickness / 2 - 4
    this.track = document.createElementNS(SVG, 'path')
    this.track.setAttribute('class', 'kit-ring-track')
    this.fill = document.createElementNS(SVG, 'path')
    this.fill.setAttribute('class', 'kit-ring-fill')
    for (const p of [this.track, this.fill]) { p.setAttribute('stroke-width', String(thickness)); p.setAttribute('fill', 'none') }
    this.track.setAttribute('d', arcPath(c, c, r, this.o.start, this.o.start + this.o.sweep))
    if (kind === 'dots') {
      // A ring of dots across the sweep, ends included (a whole ring doesn't repeat its first).
      const n = this.o.dots, whole = this.o.sweep >= 360
      for (let i = 0; i < n; i++) {
        const [x, y] = polar(c, c, r, this.o.start + (this.o.sweep * i) / (whole ? n : n - 1))
        const d = document.createElementNS(SVG, 'circle')
        d.setAttribute('cx', String(n2(x)))
        d.setAttribute('cy', String(n2(y)))
        d.setAttribute('r', String(n2(Math.max(1.2, thickness / 3.2))))
        d.setAttribute('class', 'kit-ring-dot')
        this.dots.push(d)
        svg.append(d)
      }
    } else svg.append(this.track, this.fill)
    this.knob = document.createElementNS(SVG, 'circle')
    this.knob.setAttribute('class', 'kit-ring-knob')
    this.knob.setAttribute('r', String(thickness * 0.95))
    if (opts.interactive) svg.append(this.knob)
    const mid = document.createElement('div')
    mid.className = 'kit-ring-mid'
    this.out = document.createElement('span')
    this.out.className = 'kit-ring-value'
    mid.append(this.out)
    if (opts.caption) {
      const cap = document.createElement('small')
      cap.textContent = opts.caption
      mid.append(cap)
    }
    el.append(svg, mid)
    if (opts.interactive) this.dial()
    else { el.setAttribute('role', 'meter'); el.setAttribute('aria-label', opts.label); el.setAttribute('aria-valuemin', String(this.o.min)); el.setAttribute('aria-valuemax', String(this.o.max)) }
    this.render()
  }

  get value() { return this.current }
  set value(v: number) { this.current = v; this.render() }

  private dial() {
    const el = this.el, { min, max, start, sweep } = this.o
    const step = this.opts.step ?? (max - min) / 100
    el.tabIndex = 0
    el.setAttribute('role', 'slider')
    el.setAttribute('aria-label', this.opts.label)
    el.setAttribute('aria-valuemin', String(min))
    el.setAttribute('aria-valuemax', String(max))
    el.classList.add('kit-dial')
    const at = (e: PointerEvent) => {
      const r = this.svg.getBoundingClientRect()
      const deg = (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI
      return Math.round(valueOfAngle(deg, min, max, start, sweep) / step) * step
    }
    let held: number | null = null
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); held = e.pointerId; el.setPointerCapture(e.pointerId); el.focus({ preventScroll: true }); this.set(at(e)) })
    el.addEventListener('pointermove', (e) => { if (e.pointerId === held) this.set(at(e)) })
    const up = (e: PointerEvent) => { if (e.pointerId === held) { held = null; this.opts.onChange?.(this.current) } }
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('keydown', (e) => {
      const big = (max - min) / 10
      const v = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? this.current + step
        : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? this.current - step
        : e.key === 'PageUp' ? this.current + big : e.key === 'PageDown' ? this.current - big
        : e.key === 'Home' ? min : e.key === 'End' ? max : null
      if (v === null) return
      e.preventDefault()
      this.set(v)
      this.opts.onChange?.(this.current)
    })
  }

  private set(v: number) {
    const { min, max } = this.o
    const next = Math.max(min, Math.min(max, +v.toFixed(10)))
    if (next === this.current) return
    this.current = next
    this.render()
    this.opts.onInput?.(next)
  }

  private render() {
    const { min, max, start, sweep, size, thickness } = this.o
    const c = size / 2, r = c - thickness / 2 - 4
    const f = max > min ? Math.max(0, Math.min(1, (this.current - min) / (max - min))) : 0
    const end = angleOf(this.current, min, max, start, sweep)
    if (this.dots.length) {
      const lit = litDots(this.dots.length, f)
      this.dots.forEach((d, i) => d.classList.toggle('on', i < lit))
    } else this.fill.setAttribute('d', f > 0 ? arcPath(c, c, r, start, end) : '')
    const [kx, ky] = polar(c, c, r, end)
    this.knob.setAttribute('cx', String(n2(kx)))
    this.knob.setAttribute('cy', String(n2(ky)))
    const text = this.opts.format?.(this.current) ?? String(Math.round(this.current * 100) / 100)
    this.out.textContent = text
    this.el.setAttribute('aria-valuenow', String(this.current))
    this.el.setAttribute('aria-valuetext', this.opts.caption ? `${text} ${this.opts.caption}` : text)
    this.el.style.setProperty('--f', String(f))
  }
}

export interface CapsuleOptions {
  label: string
  /** 0 to 1. */
  value: number
  /** Standing (it fills upward, a battery) or lying (it fills rightward). */
  vertical?: boolean
  format?: (value: number) => string
}

/** A pill that fills from one end: a battery, a tank, a charge. A meter for assistive tech. */
export class CapsuleGauge {
  readonly el: HTMLDivElement
  private current: number
  constructor(private opts: CapsuleOptions) {
    this.current = opts.value
    const el = this.el = document.createElement('div')
    el.className = `kit-capsule${opts.vertical ? ' kit-capsule-v' : ''}`
    el.setAttribute('role', 'meter')
    el.setAttribute('aria-label', opts.label)
    el.setAttribute('aria-valuemin', '0')
    el.setAttribute('aria-valuemax', '1')
    const fill = document.createElement('span')
    fill.className = 'kit-capsule-fill'
    el.append(fill)
    this.render()
  }
  get value() { return this.current }
  set value(v: number) { this.current = v; this.render() }
  private render() {
    const f = Math.max(0, Math.min(1, this.current))
    this.el.style.setProperty('--fill', `${(f * 100).toFixed(1)}%`)
    this.el.setAttribute('aria-valuenow', String(f))
    this.el.setAttribute('aria-valuetext', this.opts.format?.(f) ?? `${Math.round(f * 100)}%`)
    this.el.dataset.low = String(f < 0.2)
  }
}
