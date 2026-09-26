/** DOM helpers shared by the bridge (isolated world) and the page script (MAIN world). Each bundles its own copy. */
import type { Rect } from '../shared/viewer'

/** The part of an element's box inside the viewport, or null if it is hidden or off screen. */
export function visibleRect(el: Element): Rect | null {
  const r = el.getBoundingClientRect()
  const left = Math.max(0, r.left)
  const top = Math.max(0, r.top)
  const right = Math.min(innerWidth, r.right)
  const bottom = Math.min(innerHeight, r.bottom)
  if (right - left < 2 || bottom - top < 2) return null
  if (getComputedStyle(el).visibility === 'hidden') return null
  return { left, top, width: right - left, height: bottom - top }
}

/** The largest visible <canvas> or <model-viewer>: where a web 3D view (or game) almost always lives. */
export function largestView(): { el: Element; rect: Rect; area: number } | null {
  let best: { el: Element; rect: Rect; area: number } | null = null
  for (const el of document.querySelectorAll('canvas, model-viewer')) {
    const rect = visibleRect(el)
    if (!rect) continue
    const area = rect.width * rect.height
    if (!best || area > best.area) best = { el, rect, area }
  }
  return best
}

/** Hit-test through open shadow roots, so <model-viewer> and other web components get events on their inner surface. */
export function deepElementFromPoint(x: number, y: number, doc: Document = document): Element | null {
  let el = doc.elementFromPoint(x, y)
  for (let i = 0; el?.shadowRoot && i < 16; i++) {
    const inner = el.shadowRoot.elementFromPoint(x, y)
    if (!inner || inner === el) break
    el = inner
  }
  return el
}

/** An element under a point, with the window it lives in and the point in that window's client coordinates. */
export interface Hit { el: Element; view: Window; x: number; y: number; ox: number; oy: number }

/**
 * Hit-test through open shadow roots and into same-origin frames (a cross-origin frame stays the target itself), so a
 * click at a cursor lands on the element a real mouse would hit. ox/oy turn this window's coordinates into the target
 * window's: local = (x − ox, y − oy).
 */
export function deepHit(x: number, y: number): Hit {
  let view: Window = window
  let doc: Document = document
  let ox = 0
  let oy = 0
  for (let i = 0; i < 8; i++) {
    const el = deepElementFromPoint(x - ox, y - oy, doc) ?? doc.body ?? doc.documentElement
    let inner: Document | null = null
    let win: Window | null = null
    if (el instanceof HTMLIFrameElement || (view !== window && (el as Element).tagName === 'IFRAME') || (el as Element).tagName === 'FRAME') {
      try { inner = (el as HTMLIFrameElement).contentDocument; win = (el as HTMLIFrameElement).contentWindow } catch { inner = null }
    }
    if (!inner || !win) return { el, view, x: x - ox, y: y - oy, ox, oy }
    const r = el.getBoundingClientRect()
    ox += r.left + (el as HTMLElement).clientLeft
    oy += r.top + (el as HTMLElement).clientTop
    view = win
    doc = inner
  }
  return { el: doc.body ?? doc.documentElement, view, x: x - ox, y: y - oy, ox, oy }
}

/** The focused element, looking inside open shadow roots. */
export function deepActiveElement(): Element | null {
  let el = document.activeElement
  for (let i = 0; el?.shadowRoot?.activeElement && i < 16; i++) el = el.shadowRoot.activeElement
  return el
}

/** Focus sits on a child frame's element, so that frame (not this one) receives the keys. */
export const isFrameElement = (el: Element | null) => !!el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')

/**
 * Visible child frames from another site. The bridge here can't reach into them, and without "All sites" the
 * extension can't either, so a game hosted in one (itch.io and most embeds) would get no input.
 */
export function foreignFrames(): { count: number; host: string; area: number } {
  let count = 0
  let host = ''
  let area = 0
  for (const f of document.querySelectorAll<HTMLIFrameElement>('iframe, frame')) {
    let reachable = false
    try { reachable = !!f.contentDocument } catch { /* cross-origin */ }
    if (reachable) continue
    const rect = visibleRect(f)
    if (!rect) continue
    count++
    const a = rect.width * rect.height
    if (a > area) {
      area = a
      try { host = new URL(f.src || 'about:blank', location.href).host } catch { host = '' }
    }
  }
  return { count, host, area }
}
