import { DOT_MATERIAL, DOT_TIMING, dotEase, resolveDotTokens, type DotRole, type DotScale, type DotTokens } from './dot-tokens'
import { contrast, parseColor } from './color'

const clocks = new WeakMap<Document, { listeners: Set<(now: number) => boolean>; raf: number; schedule: () => void }>()
const loadingClocks = new WeakMap<Document, { listeners: Set<(now: number) => boolean>; stop: () => void }>()
/** Finite subscribers share one frame request. Returning false releases the subscription. */
export function dotClock(tick: (now: number) => boolean, doc: Document = document): () => void {
  let clock = clocks.get(doc)
  if (!clock) {
    const current = { listeners: new Set<(now: number) => boolean>(), raf: 0, schedule: () => {} }
    const frame = (now: number) => {
      current.raf = 0
      for (const listener of [...current.listeners]) if (!listener(now)) current.listeners.delete(listener)
      current.schedule()
    }
    current.schedule = () => {
      if (doc.hidden) { doc.defaultView!.cancelAnimationFrame(current.raf); current.raf = 0 }
      else if (current.listeners.size && !current.raf) current.raf = doc.defaultView!.requestAnimationFrame(frame)
    }
    doc.addEventListener('visibilitychange', current.schedule)
    clocks.set(doc, current); clock = current
  }
  const current = clock
  current.listeners.add(tick)
  current.schedule()
  return () => {
    current.listeners.delete(tick)
    if (!current.listeners.size) { doc.defaultView!.cancelAnimationFrame(current.raf); current.raf = 0 }
  }
}

export const DOT_LOADER_STYLE = `.dot-loader{display:inline-flex;flex:none;vertical-align:middle;align-items:center;justify-content:center;gap:12%;width:var(--dot-loader-size,48px);height:var(--dot-loader-size,48px);color:var(--seal-ink,var(--bb-ink,var(--ink,currentColor)))}.dot-loader[hidden]{display:none}.dot-loader>i{display:block;flex:none;width:16%;aspect-ratio:1;border-radius:50%;background:currentColor}`

/** Pending surfaces share one moving owner, including portable cards and scene beads. Others keep their static frame. */
export function dotLoaderClock(tick: (now: number) => boolean, doc: Document = document, handoff = false): () => void {
  let clock = loadingClocks.get(doc)
  if (!clock) { clock = { listeners: new Set(), stop: () => {} }; loadingClocks.set(doc, clock) }
  const current = clock
  if (handoff) current.listeners = new Set([tick, ...current.listeners])
  else current.listeners.add(tick)
  if (current.listeners.size === 1) current.stop = dotClock(now => {
    const owner = current.listeners.values().next().value
    if (owner && !owner(now)) current.listeners.delete(owner)
    return current.listeners.size > 0
  }, doc)
  return () => { current.listeners.delete(tick); if (!current.listeners.size) current.stop() }
}

/** The flat and scene adapters use the same absolute phase, without restarting on state updates. */
export function dotLoaderFrame(now: number, index: number) {
  const wave = (1 + Math.sin(now / 180 - index * 0.8)) / 2
  return { lift: wave * 0.22, scale: 0.85 + wave * 0.15, opacity: 0.7 + wave * 0.3 }
}

/** A stable three-dot loader. State updates never restart its phase or change its measured box. */
export class DotLoader {
  readonly el = document.createElement('span')
  private dots = Array.from({ length: 3 }, () => document.createElement('i'))
  private stop = () => {}
  private running = false
  private motion = matchMedia('(prefers-reduced-motion: reduce)')
  private visible = true
  private observer: IntersectionObserver | null = null
  constructor(options: { size?: number; label?: string } = {}) {
    this.el.className = 'dot-loader'
    this.el.style.setProperty('--dot-loader-size', `${Math.max(16, options.size ?? 48)}px`)
    this.el.setAttribute('role', 'status')
    this.el.setAttribute('aria-label', options.label ?? 'Loading')
    this.dots.forEach(dot => dot.setAttribute('aria-hidden', 'true'))
    this.el.append(...this.dots)
    this.motion.addEventListener('change', this.sync)
    document.addEventListener('visibilitychange', this.sync)
    this.observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { this.visible = entries.some(entry => entry.isIntersecting); this.sync() }) : null
    this.observer?.observe(this.el)
    this.start()
  }
  start() { if (!this.running) { this.running = true; this.el.setAttribute('aria-busy', 'true'); this.sync() } }
  finish() { if (this.running) { this.running = false; this.el.setAttribute('aria-busy', 'false'); this.sync() } }
  private sync = () => {
    this.stop()
    this.dots.forEach(dot => { dot.style.transform = 'none'; dot.style.opacity = '1' })
    if (!this.running || this.motion.matches || document.hidden || !this.visible) return
    this.stop = dotLoaderClock(now => {
      if (!this.running) return false
      if (this.el.isConnected) this.dots.forEach((dot, i) => {
        const frame = dotLoaderFrame(now, i)
        dot.style.transform = `translate3d(0,${-frame.lift * 100}%,0) scale(${frame.scale})`
        dot.style.opacity = String(frame.opacity)
      })
      return true
    })
  }
  destroy() { this.finish(); this.observer?.disconnect(); this.motion.removeEventListener('change', this.sync); document.removeEventListener('visibilitychange', this.sync) }
}

/** A position normalized to the canvas, from 0 to 1 on each axis. */
export interface DotPoint { x: number; y: number; role?: DotRole }
export interface DotFieldOptions {
  /** Omit for a grid; an empty array leaves the canvas clear. */
  points?: readonly DotPoint[]
  scale?: DotScale
  role?: DotRole
  diameter?: number
  /** Seal samples keep every cell. Displacement is opt-in for decorative fields only. */
  preservePoints?: boolean
  decorative?: boolean
  spacing?: number
  maxDots?: number
  /** Concrete CSS colours. Otherwise the canvas inherits the family or shadow chip tokens. */
  accent?: string
  surface?: string
  /** The idle breath animates compositor opacity, without drawing any new frames. */
  idle?: boolean
  /** Align a resting canvas origin once to backing pixels; moving flight canvases leave this off. */
  pixelAligned?: boolean
}
export type DotEffect = 'assemble' | 'ripple' | 'shimmer' | 'handshake'

const clamp = (n: number, low = 0, high = 1) => Math.max(low, Math.min(high, n))
const ease = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t) }
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const TAU = Math.PI * 2
const BANDS = 12
const ROLES: readonly DotRole[] = ['active', 'light', 'ink', 'muted', 'depth']

interface Effect { kind: DotEffect; start: number; duration: number }
interface Dot { x: number; y: number; phase: number; role?: DotRole }
interface Paint { x: number; y: number; radius: number; square: boolean }

/**
 * A decorative Canvas 2D field shared by the app and embed. Only finite effects own a RAF loop; the idle breath
 * uses compositor opacity. Coordinates and timing are deterministic so both ends can show the same handshake.
 */
export class DotField {
  private readonly context: CanvasRenderingContext2D | null
  private readonly limit: number
  private readonly spacing: number
  private readonly motion: MediaQueryList | null
  private readonly resizeObserver: ResizeObserver | null
  private readonly intersectionObserver: IntersectionObserver | null
  private readonly tokenObserver: MutationObserver | null
  private readonly bands: Paint[][] = Array.from({ length: BANDS * ROLES.length }, () => [])
  private readonly paints: Paint[] = []
  private points?: DotPoint[]
  private source: DotPoint[] = []
  private dots: Dot[] = []
  private width = 0
  private height = 0
  private dpr = 1
  private accent = ''
  private surface = ''
  private tokens!: DotTokens
  private radius = 2
  private sourceRadius = 2
  private at: { x: number; y: number } | null = null
  private light = { x: 0, y: 0 }
  private part: { start: number; duration: number; from: number; to: number } | null = null
  private strength = 0
  private playing: Effect | null = null
  private progress: number | null = null
  private frame = 0
  private rendered = 0
  private intersecting = true
  private dead = false
  private opacity: Animation | null = null
  private aligned = { x: 0, y: 0 }

  get frames() { return this.rendered }
  get resolvedTokens() { return this.tokens }
  get normalizedPoints(): readonly DotPoint[] { return this.points ?? this.dots.map(p => ({ x: p.x / this.width, y: p.y / this.height })) }
  get dotCount() { return this.dots.length }

  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: DotFieldOptions = {}) {
    this.context = canvas.getContext('2d')
    this.limit = clamp(Math.floor(options.maxDots ?? 300) || 300, 1, 300)
    this.spacing = Math.max(4, Number.isFinite(options.spacing) ? options.spacing! : resolveDotTokens(canvas, options.scale).pitch)
    this.points = options.points ? this.normalize(options.points, options.preservePoints ? 4096 : this.limit) : undefined
    this.motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
    this.motion?.addEventListener('change', this.motionChanged)
    canvas.ownerDocument.addEventListener('visibilitychange', this.visibilityChanged)
    canvas.ownerDocument.defaultView?.addEventListener('resize', this.resize)
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(this.resize) : null
    this.resizeObserver?.observe(canvas)
    this.intersectionObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      this.intersecting = entries.some(entry => entry.isIntersecting)
      this.visibilityChanged()
    }) : null
    this.intersectionObserver?.observe(canvas)
    this.tokenObserver = typeof MutationObserver === 'function' ? new MutationObserver(() => this.refresh()) : null
    if (canvas.ownerDocument.documentElement) this.tokenObserver?.observe(canvas.ownerDocument.documentElement, {
      attributes: true, attributeFilter: ['class', 'style', 'data-bb-theme', 'data-bb-accent', 'data-bb-product'],
    })
    this.refresh()
    this.resize()
    this.breathe()
  }

  private get visible() { return !this.dead && !!this.context && !this.canvas.ownerDocument.hidden && this.intersecting && this.width > 0 && this.height > 0 }
  private get reduced() { return this.motion?.matches ?? false }

  private normalize(points: readonly DotPoint[], limit = this.limit): DotPoint[] {
    const valid = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    const count = Math.min(valid.length, limit)
    return Array.from({ length: count }, (_, i) => {
      const p = valid[Math.floor(i * valid.length / count)]
      return { x: clamp(p.x), y: clamp(p.y), ...(p.role && ROLES.includes(p.role) ? { role: p.role } : {}) }
    })
  }

  /** Switch between a normalized glyph and the adaptive grid. */
  setPoints(points?: readonly DotPoint[]) {
    if (this.dead) return
    this.points = points ? this.normalize(points, this.options.preservePoints ? 4096 : this.limit) : undefined
    this.layout()
    this.draw(performance.now())
  }

  /** Preserve up to 4,096 normalized QR module centres. Surplus modules fade before the bounded glyph settles. */
  setSource(points: readonly DotPoint[]) {
    if (this.dead) return
    this.source = this.normalize(points, 4096)
    this.measureSource()
  }

  private layout() {
    if (!this.width || !this.height) { this.dots = []; return }
    let points = this.points
    if (!points) {
      const space = Math.max(this.spacing, Math.sqrt(this.width * this.height / this.limit))
      let cols = Math.max(1, Math.floor(this.width / space)), rows = Math.max(1, Math.floor(this.height / space))
      while (cols * rows > this.limit) { if (cols >= rows) cols--; else rows-- }
      points = []
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) points.push({ x: (x + 0.5) / cols, y: (y + 0.5) / rows })
    }
    this.dots = points.map((p, i) => ({ x: p.x * this.width, y: p.y * this.height, role: p.role, phase: ((i * 137 + 17) % 997) / 997 }))
    const diameter = this.options.diameter ?? this.tokens.diameter
    const radius = this.points && this.tokens.scale === 'seal' ? Math.min(diameter, this.gridPitch(this.points) * (this.options.preservePoints ? 0.9 : 0.64)) / 2 : diameter / 2
    this.radius = Math.min(radius, this.width / 8, this.height / 8)
    this.measureSource()
  }

  private gridPitch(points: readonly DotPoint[]) {
    let step = this.spacing
    for (const [axis, size] of [['x', this.width], ['y', this.height]] as const) {
      const positions = [...new Set(points.map(p => p[axis]))].sort((a, b) => a - b)
      for (let i = 1; i < positions.length; i++) {
        const gap = (positions[i] - positions[i - 1]) * size
        if (gap > 0.0001) step = Math.min(step, gap)
      }
    }
    return step
  }

  private measureSource() {
    this.sourceRadius = Math.max(0.6, this.gridPitch(this.source) * 0.42)
  }

  /** Fit the backing pixels to the element and the display, without changing its CSS size. */
  resize = () => {
    if (this.dead) return
    let rect = this.canvas.getBoundingClientRect()
    const dpr = clamp(Number.isFinite(globalThis.devicePixelRatio) ? globalThis.devicePixelRatio : 1, 1, 3)
    if (this.options.pixelAligned && this.canvas.style && rect.width > 0) {
      const height = `${Math.round(rect.width * 11 / 35 * dpr) / dpr}px`
      if (this.canvas.style.height !== height) { this.canvas.style.height = height; rect = this.canvas.getBoundingClientRect() }
    }
    if (this.width === rect.width && this.height === rect.height && this.dpr === dpr) return
    this.width = Math.max(0, rect.width)
    this.height = Math.max(0, rect.height)
    this.dpr = dpr
    this.canvas.width = Math.round(this.width * dpr)
    this.canvas.height = Math.round(this.height * dpr)
    this.context?.setTransform(this.width ? this.canvas.width / this.width : 1, 0, 0, this.height ? this.canvas.height / this.height : 1, 0, 0)
    // A seal is often built before insertion. Its first measured size resolves the actual inherited tokens.
    const root = this.canvas.getRootNode?.()
    if (root && 'host' in root) this.tokenObserver?.observe((root as ShadowRoot).querySelector('.wrap') ?? (root as ShadowRoot).host, {
      attributes: true, attributeFilter: ['class', 'style'],
    })
    this.refresh()
    this.visibilityChanged()
  }

  /** Resolve family tokens again after a theme change, including the pairing chip's shadow tokens. */
  refresh() {
    if (this.dead) return
    if (this.options.pixelAligned && this.canvas.style) {
      const rect = this.canvas.getBoundingClientRect()
      const x = rect.left - this.aligned.x, y = rect.top - this.aligned.y
      this.aligned = { x: Math.round(x * this.dpr) / this.dpr - x, y: Math.round(y * this.dpr) / this.dpr - y }
      this.canvas.style.translate = `${this.aligned.x}px ${this.aligned.y}px`
    }
    this.tokens = resolveDotTokens(this.canvas, this.options.scale ?? (this.options.points ? 'seal' : 'base'))
    if (this.options.preservePoints && this.tokens.scale === 'seal') {
      const style = getComputedStyle(this.canvas)
      const accent = style.getPropertyValue('--bb-accent-text').trim()
      const plate = parseColor(style.getPropertyValue('--seal-plate')) ?? parseColor(style.getPropertyValue('--bb-sheet'))
      const ink = parseColor(accent)
      // Small raster cores need headroom beyond the nominal token contrast. Light surfaces use strong ink only.
      if (plate && ink && contrast(ink, plate) >= 10) this.tokens.colors.active = accent
    }
    this.accent = this.options.accent || this.tokens.colors[this.options.role ?? 'active']
    this.surface = this.options.surface || this.tokens.surface
    this.layout()
    this.draw(performance.now())
  }

  /** Run a finite effect. The handshake takes 1.2 seconds unless a synchronized caller drives it manually. */
  effect(kind: DotEffect, duration: number = DOT_TIMING[kind]) {
    if (this.dead) return
    this.stopFrame()
    this.opacity?.cancel(); this.opacity = null
    this.progress = null
    this.playing = this.reduced ? null : { kind, start: performance.now(), duration: Math.max(1, Number.isFinite(duration) ? duration : 700) }
    if (this.reduced) {
      this.draw(performance.now())
      this.opacity = this.canvas.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: DOT_TIMING.fade, iterations: 1 }) ?? null
      if (!this.visible) this.opacity?.pause()
    } else {
      this.draw(performance.now())
      this.schedule()
    }
  }

  /** A pointer or touch position in canvas-local CSS pixels. A stationary pointer never starts a loop. */
  pointer(x: number | null, y?: number) {
    if (this.dead || this.reduced) return
    const at = x === null || !Number.isFinite(x) || !Number.isFinite(y) ? null : { x, y: y! }
    if (this.at?.x === at?.x && this.at?.y === at?.y) return
    if (this.options.decorative) {
      const now = performance.now()
      this.stopFrame(); this.playing = null
      this.opacity?.cancel(); this.opacity = null
      if (at) this.at = at
      this.part = { start: now, duration: at ? DOT_TIMING.partIn : DOT_TIMING.partOut, from: this.strength, to: at ? 1 : 0 }
      this.draw(now); this.schedule()
    } else {
      this.at = at
      this.opacity?.cancel(); this.opacity = null
      this.draw(performance.now())
    }
  }

  /** Light coordinates from already permitted motion input, normalized from -1 to 1. No sensor is requested. */
  tilt(x: number, y: number) {
    if (this.dead || this.reduced || !Number.isFinite(x) || !Number.isFinite(y)) return
    x = clamp(x, -1, 1); y = clamp(y, -1, 1)
    if (x === this.light.x && y === this.light.y) return
    this.light = { x, y }
    this.draw(performance.now())
  }

  /** Draw a deterministic QR lift, ribbon, glyph and ripple frame; it never starts its own RAF loop. */
  handshake(progress: number, measure = false) {
    if (this.dead || !Number.isFinite(progress)) return
    this.stopFrame()
    this.playing = null
    this.opacity?.cancel(); this.opacity = null
    this.progress = this.reduced ? 1 : clamp(progress)
    // A newly visible flight measures once before presentation; later frames need no layout read.
    if (measure) this.resize()
    this.draw(performance.now())
  }

  private stopFrame() { if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0 }
  private schedule() {
    if (this.visible && (this.playing || this.part) && !this.frame) this.frame = requestAnimationFrame(now => {
      this.frame = 0
      this.draw(now)
      this.schedule()
    })
  }

  private visibilityChanged = () => {
    if (!this.visible) { this.stopFrame(); this.opacity?.pause(); return }
    this.opacity?.play()
    this.draw(performance.now())
    this.schedule()
  }

  private motionChanged = () => {
    this.stopFrame()
    this.playing = null
    this.at = null
    this.part = null
    this.strength = 0
    this.light = { x: 0, y: 0 }
    if (this.reduced && this.progress !== null) this.progress = 1
    this.breathe()
    this.draw(performance.now())
  }

  private breathe() {
    this.opacity?.cancel()
    this.opacity = !this.reduced && this.options.idle === true
      ? this.canvas.animate?.([{ opacity: 0.86 }, { opacity: 1 }, { opacity: 0.86 }], { duration: DOT_TIMING.breathe, iterations: 2 }) ?? null
      : null
    if (!this.visible) this.opacity?.pause()
  }

  /** Draw without scheduling another; the finished field has at most 300 dots, with a larger QR source during lift. */
  draw(now: number) {
    const context = this.context
    if (!this.visible || !context) return
    this.rendered++
    context.globalAlpha = 1
    context.clearRect(0, 0, this.width, this.height)
    if (this.surface !== 'transparent') { context.fillStyle = this.surface; context.fillRect(0, 0, this.width, this.height) }
    if (this.part) {
      const p = clamp((now - this.part.start) / this.part.duration)
      this.strength = lerp(this.part.from, this.part.to, dotEase(p))
      if (p === 1) { if (!this.part.to) this.at = null; this.part = null }
    }
    const effect = this.playing
    const t = effect ? clamp((now - effect.start) / effect.duration) : 1
    const handshake = this.progress ?? (effect?.kind === 'handshake' ? t : null)
    const sourceCount = this.source.length || this.dots.length
    const count = handshake !== null && handshake < 1 ? Math.max(sourceCount, this.dots.length) : this.dots.length
    const diagonal = Math.hypot(this.width, this.height)
    for (const band of this.bands) band.length = 0
    for (let i = 0; i < count; i++) {
      const dot = this.dots[i % this.dots.length]
      const source = this.source[i % this.source.length]
      let x = dot?.x ?? this.width / 2, y = dot?.y ?? this.height / 2, radius = this.radius, square = false
      const seal = this.options.preservePoints && this.tokens.scale === 'seal'
      let alpha = this.points ? (seal ? 1 : 0.76) : 0.25 + (dot?.phase ?? 0.5) * 0.13
      if (handshake !== null) {
        const p = handshake
        const sx = source ? source.x * this.width : x, sy = source ? source.y * this.height : y
        const ribbonX = this.width * (0.18 + 0.64 * (count > 1 ? i / (count - 1) : 0.5))
        const ribbonY = this.height / 2 + Math.sin(i * 0.21) * 0.9
        square = p < 0.1
        if (p < 0.22) {
          x = sx; y = sy - Math.sin(p / 0.22 * Math.PI / 2) * Math.min(12, this.height * 0.15)
          radius = lerp(this.sourceRadius, this.radius, ease(p / 0.22))
        } else if (p < 0.45) {
          const lift = Math.min(12, this.height * 0.15), f = ease((p - 0.22) / 0.23)
          x = lerp(sx, ribbonX, f); y = lerp(sy - lift, ribbonY, f)
        } else if (p < 0.72) {
          const f = ease((p - 0.45) / 0.27)
          x = lerp(ribbonX, x, f); y = lerp(ribbonY, y, f)
        } else {
          const wave = (p - 0.72) / 0.28
          const distance = Math.hypot(x - this.width / 2, y - this.height / 2) / diagonal
          const ring = Math.exp(-(((distance - wave * 0.65) / 0.12) ** 2)) * Math.sin(wave * Math.PI)
          radius *= 1 + ring * 0.2
          alpha += ring * 0.24
        }
        if (i >= sourceCount) alpha *= ease((p - 0.22) / 0.5)
        if (i >= this.dots.length) alpha *= 1 - ease((p - 0.42) / 0.2)
      } else if (effect?.kind === 'assemble') {
        const f = dotEase((t - (dot?.phase ?? 0) * 0.125) / 0.875, true)
        x = lerp(this.width / 2, x, f); y = lerp(this.height / 2, y, f)
        alpha *= f
      } else if (effect?.kind === 'ripple') {
        const distance = Math.hypot(x - this.width / 2, y - this.height / 2) / diagonal
        const ring = Math.exp(-(((distance - dotEase(t, true) * 0.65) / 0.1) ** 2)) * Math.sin(t * Math.PI)
        radius *= 1 + ring * 0.2
        alpha += ring * 0.4
      } else if (effect?.kind === 'shimmer') {
        const shine = Math.exp(-(((x / this.width - dotEase(t) * 1.4 + 0.2) / 0.12) ** 2)) * Math.sin(t * Math.PI)
        alpha += shine * 0.5
      }
      if (this.options.decorative && this.at && !this.reduced && handshake === null) {
        const dx = x - this.at.x, dy = y - this.at.y, distance = Math.hypot(dx, dy)
        const influence = Math.max(0, 1 - distance / DOT_MATERIAL.touchRadius) ** 2 * this.strength
        if (distance > 0) { x += dx / distance * influence * Math.min(DOT_MATERIAL.maxTouch, this.spacing * 0.45); y += dy / distance * influence * Math.min(DOT_MATERIAL.maxTouch, this.spacing * 0.45) }
        alpha += influence * 0.52
      }
      if (!this.options.decorative && this.at && !this.reduced && handshake === null) {
        alpha += Math.max(0, 1 - Math.hypot(x - this.at.x, y - this.at.y) / DOT_MATERIAL.touchRadius) ** 2 * 0.24
      }
      if (!this.reduced) alpha += ((x / this.width - 0.5) * this.light.x + (y / this.height - 0.5) * this.light.y) * 0.2
      // Keep the comparison silhouette legible through the light sweep and tilt; surplus QR modules still fade.
      if (seal && i < this.dots.length && (handshake === null || handshake >= 0.72)) alpha = 1
      if (alpha <= 0) continue
      const role = ROLES.indexOf(dot?.role ?? this.options.role ?? 'active')
      const band = role * BANDS + Math.round(clamp(alpha) * (BANDS - 1))
      const paint = this.paints[i] ?? (this.paints[i] = { x, y, radius, square })
      paint.x = x; paint.y = y; paint.radius = radius; paint.square = square
      this.bands[band].push(paint)
    }
    context.fillStyle = this.accent
    // Twelve opacity paths per used semantic role keep the CPU and raster work bounded.
    for (let b = 0; b < this.bands.length; b++) {
      if (!this.bands[b].length) continue
      context.fillStyle = this.options.accent || this.tokens.colors[ROLES[Math.floor(b / BANDS)]]
      context.globalAlpha = b % BANDS / (BANDS - 1)
      context.beginPath()
      for (const dot of this.bands[b]) {
        if (dot.square) context.rect(dot.x - dot.radius, dot.y - dot.radius, dot.radius * 2, dot.radius * 2)
        else { context.moveTo(dot.x + dot.radius, dot.y); context.arc(dot.x, dot.y, dot.radius, 0, TAU) }
      }
      context.fill()
    }
    context.globalAlpha = 1
    if (effect && t === 1) { this.playing = null; this.stopFrame() }
  }

  /** Release RAF, observers, listeners and compositor animation when its owning surface closes. */
  destroy() {
    if (this.dead) return
    this.dead = true
    this.stopFrame()
    this.opacity?.cancel()
    this.resizeObserver?.disconnect()
    this.intersectionObserver?.disconnect()
    this.tokenObserver?.disconnect()
    this.motion?.removeEventListener('change', this.motionChanged)
    this.canvas.ownerDocument.removeEventListener('visibilitychange', this.visibilityChanged)
    this.canvas.ownerDocument.defaultView?.removeEventListener('resize', this.resize)
  }
}
