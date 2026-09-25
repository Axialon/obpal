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

  constructor(private el: HTMLElement) {
    el.addEventListener('pointerdown', this.down)
    el.addEventListener('pointermove', this.move)
    el.addEventListener('pointerup', this.up)
    el.addEventListener('pointercancel', this.up)
    el.addEventListener('lostpointercapture', this.up)
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
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    this.touches = this.pts.size
    if (this.pts.size === 1) {
      this.downAt = performance.now()
      this.downPos = { x: e.clientX, y: e.clientY }
      this.moved = false
      this.longFired = false
      this.clearLong()
      this.longTimer = setTimeout(() => {
        if (!this.moved && this.pts.size === 1) { this.longFired = true; this.onTap?.('long') }
      }, 520)
      this.onTouchChange?.(true)
    } else {
      this.clearLong()
      this.moved = true
      if (this.pts.size === 2) this.two = this.measure()
    }
  }

  private move = (e: PointerEvent) => {
    const p = this.pts.get(e.pointerId)
    if (!p) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    p.x = e.clientX
    p.y = e.clientY
    if (this.pts.size === 1) {
      this.pad1[0] += dx
      this.pad1[1] += dy
      if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 8) { this.moved = true; this.clearLong() }
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
    }
  }

  private up = (e: PointerEvent) => {
    if (!this.pts.delete(e.pointerId)) return
    this.touches = this.pts.size
    this.two = this.pts.size === 2 ? this.measure() : null
    if (this.pts.size > 0) return
    this.clearLong()
    const now = performance.now()
    if (!this.moved && !this.longFired && now - this.downAt < 320) {
      if (now - this.lastTap < 320) { this.lastTap = 0; this.onTap?.('double') }
      else { this.lastTap = now; this.onTap?.('tap') }
    }
    this.onTouchChange?.(false)
  }

  private clearLong() {
    if (this.longTimer) { clearTimeout(this.longTimer); this.longTimer = null }
  }
}
