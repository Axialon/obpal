/**
 * The slider with detents: a glass track filled with the accent up to a round knob, with named stops along it (Slow,
 * Regular, Max) that the knob settles into when let go near one. It's an ARIA slider: the arrow keys step, Page Up and
 * Page Down jump from stop to stop, Home and End go to the ends, and a stop's name is what assistive tech reads there.
 * A finger or a mouse drags anywhere along it; a horizontal one leaves vertical swipes to the page, a vertical one the
 * reverse. `vertical` stands it up, the minimum at the bottom.
 */
import '../../styles/kit.css'

export interface Detent { value: number; label?: string }

/** `value` clamped to [min, max] and rounded to a whole number of steps from min. */
export function quantize(value: number, min: number, max: number, step: number): number {
  const v = Math.max(min, Math.min(max, value))
  if (!(step > 0)) return v
  const n = Math.round((v - min) / step)
  return Math.max(min, Math.min(max, +(min + n * step).toFixed(10)))
}

/** The nearest stop within `radius` of `value`, or `value` itself. */
export function snapTo(value: number, stops: readonly number[], radius: number): number {
  let best = value, gap = radius
  for (const s of stops) {
    const d = Math.abs(s - value)
    if (d <= gap) { best = s; gap = d }
  }
  return best
}

/** The next stop above `value` (dir 1) or below it (dir -1); `value` when there's none that way. */
export function nextStop(value: number, stops: readonly number[], dir: 1 | -1): number {
  const eps = 1e-9
  const sorted = [...stops].sort((a, b) => a - b)
  if (dir > 0) return sorted.find((s) => s > value + eps) ?? value
  return [...sorted].reverse().find((s) => s < value - eps) ?? value
}

/** How far along [min, max] `value` is, from 0 to 1. */
export function share(value: number, min: number, max: number): number {
  return max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0
}

export interface SliderOptions {
  label: string
  min: number
  max: number
  step?: number
  value: number
  /** Named stops; the knob settles into one let go within `snap` of it. */
  detents?: readonly Detent[]
  /** How near (in the value's units) a stop pulls the knob in: a twentieth of the range unless given. */
  snap?: number
  vertical?: boolean
  /** The value as words, where no stop names it (assistive tech reads this). */
  format?: (value: number) => string
  /** Dragged or stepped to `value` (continuously). */
  onInput?: (value: number) => void
  /** Settled at `value` (let go, or a key). */
  onChange?: (value: number) => void
}

export class DetentSlider {
  readonly el: HTMLDivElement
  readonly thumb: HTMLDivElement
  private current: number
  private readonly step: number
  private readonly stops: number[]
  private dragging: number | null = null

  constructor(private opts: SliderOptions) {
    this.step = opts.step ?? (opts.max - opts.min) / 100
    this.stops = (opts.detents ?? []).map((d) => d.value)
    this.current = quantize(opts.value, opts.min, opts.max, this.step)
    const el = this.el = document.createElement('div')
    el.className = 'kit-slider'
    el.dataset.orient = opts.vertical ? 'v' : 'h'
    const track = document.createElement('div')
    track.className = 'kit-slider-track'
    const fill = document.createElement('span')
    fill.className = 'kit-slider-fill'
    track.append(fill)
    for (const d of opts.detents ?? []) {
      const tick = document.createElement('span')
      tick.className = 'kit-slider-detent'
      tick.style.setProperty('--at', `${share(d.value, opts.min, opts.max) * 100}%`)
      track.append(tick)
    }
    const t = this.thumb = document.createElement('div')
    t.className = 'kit-slider-knob'
    t.tabIndex = 0
    t.setAttribute('role', 'slider')
    t.setAttribute('aria-label', opts.label)
    t.setAttribute('aria-valuemin', String(opts.min))
    t.setAttribute('aria-valuemax', String(opts.max))
    if (opts.vertical) t.setAttribute('aria-orientation', 'vertical')
    track.append(t)
    el.append(track)
    if (opts.detents?.some((d) => d.label)) {
      const labels = document.createElement('div')
      labels.className = 'kit-slider-labels'
      labels.setAttribute('aria-hidden', 'true')
      for (const d of opts.detents) {
        if (!d.label) continue
        const s = document.createElement('span')
        s.textContent = d.label
        s.dataset.value = String(d.value)
        s.style.setProperty('--at', `${share(d.value, opts.min, opts.max) * 100}%`)
        labels.append(s)
      }
      el.append(labels)
    }
    track.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return
      e.preventDefault()
      this.dragging = e.pointerId
      track.setPointerCapture(e.pointerId)
      t.focus({ preventScroll: true })
      el.classList.add('kit-held')
      this.set(this.at(e, track), 'input')
    })
    track.addEventListener('pointermove', (e) => { if (e.pointerId === this.dragging) this.set(this.at(e, track), 'input') })
    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.dragging) return
      this.dragging = null
      el.classList.remove('kit-held')
      this.set(snapTo(this.current, this.stops, opts.snap ?? (opts.max - opts.min) / 20), 'change')
    }
    track.addEventListener('pointerup', release)
    track.addEventListener('pointercancel', release)
    t.addEventListener('keydown', (e) => this.key(e))
    this.render()
  }

  get value() { return this.current }
  set value(v: number) { this.current = quantize(v, this.opts.min, this.opts.max, this.step); this.render() }

  private at(e: PointerEvent, track: HTMLElement) {
    const r = track.getBoundingClientRect()
    const f = this.opts.vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width
    return this.opts.min + Math.max(0, Math.min(1, f)) * (this.opts.max - this.opts.min)
  }

  private key(e: KeyboardEvent) {
    const { min, max } = this.opts
    const big = this.stops.length ? null : (max - min) / 10
    let v: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = this.current + this.step
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = this.current - this.step
    else if (e.key === 'PageUp') v = big ? this.current + big : nextStop(this.current, this.stops, 1)
    else if (e.key === 'PageDown') v = big ? this.current - big : nextStop(this.current, this.stops, -1)
    else if (e.key === 'Home') v = min
    else if (e.key === 'End') v = max
    if (v === null) return
    e.preventDefault()
    this.set(v, 'change')
  }

  private set(v: number, kind: 'input' | 'change') {
    const next = quantize(v, this.opts.min, this.opts.max, this.step)
    const moved = next !== this.current
    this.current = next
    this.render()
    if (moved || kind === 'change') this.opts.onInput?.(next)
    if (kind === 'change') this.opts.onChange?.(next)
  }

  private render() {
    const { min, max } = this.opts
    const at = share(this.current, min, max)
    this.el.style.setProperty('--fill', `${at * 100}%`)
    const stop = this.opts.detents?.find((d) => Math.abs(d.value - this.current) < 1e-9 && d.label)
    this.thumb.setAttribute('aria-valuenow', String(this.current))
    this.thumb.setAttribute('aria-valuetext', stop?.label ?? this.opts.format?.(this.current) ?? String(this.current))
    for (const s of this.el.querySelectorAll<HTMLElement>('.kit-slider-labels span')) s.classList.toggle('kit-on', Number(s.dataset.value) === this.current)
    for (const [i, tick] of [...this.el.querySelectorAll<HTMLElement>('.kit-slider-detent')].entries()) tick.classList.toggle('kit-passed', (this.stops[i] ?? Infinity) <= this.current)
  }
}
