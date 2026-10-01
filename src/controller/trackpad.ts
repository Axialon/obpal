import { toUi, uiRect } from './uiframe'
import { thumbEdge, thumbGain } from './thumb'

export type TapKind = 'tap' | 'double' | 'long'

/**
 * Multi-touch trackpad. Continuous input accumulates (never resets), so the wire format
 * can carry absolute totals and lost packets cost nothing.
 * pad1: one-finger drag (px), pad2: two-finger pan (px), zoom: log2(pinch scale), twist: degrees (+ = clockwise).
 */
export class Trackpad {
  pad1: [number, number] = [0, 0]
  pad2: [number, number] = [0, 0]
  zoom = 0
  twist = 0
  touches = 0
  onTap: ((kind: TapKind) => void) | null = null
  onTouchChange: ((touching: boolean) => void) | null = null
  private pts = new Map<number, { x: number; y: number }>()
  private two: { cx: number; cy: number; dist: number; ang: number } | null = null
  private downAt = 0
  private downPos = { x: 0, y: 0 }
  private moved = false
  private longFired = false
  private lastTap = 0
  private longTimer: ReturnType<typeof setTimeout> | null = null
  private thumb = false
  private edge: [number, number] = [0, 0]
  private raf = 0
  private frameAt = 0
  private moveAt = 0
  private twoTap = false
  private cancelled = false
  private twoStart: { cx: number; cy: number; dist: number; ang: number } | null = null
  private readonly events = new AbortController()

  constructor(private el: HTMLElement) {
    const options = { signal: this.events.signal }
    el.addEventListener('pointerdown', this.down, options)
    el.addEventListener('pointermove', this.move, options)
    el.addEventListener('pointerup', this.up, options)
    el.addEventListener('pointercancel', this.up, options)
    el.addEventListener('lostpointercapture', this.up, options)
    el.addEventListener('contextmenu', e => e.preventDefault(), options)
    window.addEventListener('blur', () => this.reset(), options)
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset() }, options)
  }

  destroy() { this.reset(); this.events.abort() }

  /** Thumb motion is optional; changing it cancels the current gesture without changing the totals. */
  setThumb(on: boolean) {
    if (on === this.thumb) return
    this.reset()
    this.thumb = on
  }

  get thumbOn() { return this.thumb }

  private continue = (now: number) => {
    const dt = Math.max(0, Math.min(32, now - this.frameAt))
    this.frameAt = now
    if (this.thumb && this.pts.size === 1 && this.moved && !this.longFired) {
      this.pad1[0] += this.edge[0] * dt
      this.pad1[1] += this.edge[1] * dt
    }
    this.raf = requestAnimationFrame(this.continue)
  }

  private measure() {
    const [a, b] = [...this.pts.values()]
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      ang: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
    }
  }

  private down = (e: PointerEvent) => {
    e.preventDefault()
    try { this.el.setPointerCapture(e.pointerId) } catch { /* synthetic events */ }
    const at = toUi(e.clientX, e.clientY)
    this.pts.set(e.pointerId, at)
    this.touches = this.pts.size
    if (this.pts.size === 1) {
      this.downAt = performance.now()
      this.moveAt = e.timeStamp
      this.cancelled = false
      this.twoTap = false
      this.edge = [0, 0]
      this.downPos = { ...at }
      this.moved = false
      this.longFired = false
      this.clearLong()
      this.longTimer = setTimeout(() => {
        if (!this.moved && this.pts.size === 1) { this.longFired = true; this.onTap?.('long') }
      }, 520)
      this.onTouchChange?.(true)
      if (this.thumb) { this.frameAt = performance.now(); this.raf = requestAnimationFrame(this.continue) }
    } else {
      this.clearLong()
      this.twoTap = !this.moved && this.pts.size === 2
      if (!this.thumb || this.pts.size > 2) this.moved = true
      this.edge = [0, 0]
      if (this.pts.size === 2) this.two = this.twoStart = this.measure()
    }
  }

  private move = (e: PointerEvent) => {
    const p = this.pts.get(e.pointerId)
    if (!p) return
    const at = toUi(e.clientX, e.clientY)
    const dx = at.x - p.x
    const dy = at.y - p.y
    p.x = at.x
    p.y = at.y
    if (this.pts.size === 1) {
      const gain = this.thumb ? thumbGain(Math.hypot(dx, dy) / Math.max(1, e.timeStamp - this.moveAt)) : 1
      this.moveAt = e.timeStamp
      this.pad1[0] += dx * gain
      this.pad1[1] += dy * gain
      if (Math.hypot(at.x - this.downPos.x, at.y - this.downPos.y) > 8) { this.moved = true; this.clearLong() }
      if (this.thumb) {
        const r = uiRect(this.el)
        // A scroll strip is a separate gesture, so the usable pad ends at its inner edge.
        const strip = this.el.querySelector<HTMLElement>('.pad-wheel:not([hidden])')
        const s = strip ? uiRect(strip) : null
        const left = s && s.left < r.left + r.width / 2 ? s.left + s.width : r.left
        const right = s && s.left > r.left + r.width / 2 ? s.left : r.left + r.width
        this.edge = thumbEdge(at.x - left, at.y - r.top, right - left, r.height)
      }
    } else if (this.pts.size === 2 && this.two) {
      const m = this.measure()
      this.pad2[0] += m.cx - this.two.cx
      this.pad2[1] += m.cy - this.two.cy
      this.zoom += Math.log2(m.dist / this.two.dist)
      let da = m.ang - this.two.ang
      if (da > 180) da -= 360
      if (da < -180) da += 360
      this.twist += da
      this.two = m
      if (this.twoStart && (Math.hypot(m.cx - this.twoStart.cx, m.cy - this.twoStart.cy) > 8 || Math.abs(m.dist - this.twoStart.dist) > 8)) { this.moved = true; this.twoTap = false }
    }
  }

  private up = (e: PointerEvent) => {
    if (!this.pts.delete(e.pointerId)) return
    if (e.type !== 'pointerup') this.cancelled = true
    this.edge = [0, 0]
    this.touches = this.pts.size
    this.two = this.pts.size === 2 ? this.measure() : null
    if (this.pts.size > 0) return
    this.clearLong()
    cancelAnimationFrame(this.raf)
    const now = performance.now()
    if (!this.cancelled && !this.moved && !this.longFired && now - this.downAt < 320) {
      if (this.thumb && this.twoTap) { this.lastTap = 0; this.onTap?.('long') }
      else {
        if (now - this.lastTap < 320) { this.lastTap = 0; this.onTap?.('double') }
        else { this.lastTap = now; this.onTap?.('tap') }
      }
    }
    this.onTouchChange?.(false)
  }

  private clearLong() {
    if (this.longTimer) { clearTimeout(this.longTimer); this.longTimer = null }
  }

  /** A connection switch cancels every gesture, including a long press still waiting to fire. */
  reset() {
    const touching = this.touches > 0
    this.clearLong()
    cancelAnimationFrame(this.raf)
    this.edge = [0, 0]
    this.pts.clear()
    this.two = null
    this.touches = 0
    this.moved = true
    this.lastTap = 0
    if (touching) this.onTouchChange?.(false)
  }
}
