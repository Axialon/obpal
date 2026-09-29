/**
 * Where a popover goes: next to what opened it, inside the frame it lives in; and where something on a screen edge goes
 * along it, clear of what else is there. The frame is the viewport, unless a page turns its UI against the viewport
 * (the phone controller locks its orientation that way, ../../controller/uiframe.ts): then it says how to measure in
 * its own frame with setPopoverFrame(). The placement itself is pure.
 */

export interface Box { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }
export type Side = 'below' | 'above' | 'right' | 'left'
export interface Placement { left: number; top: number; maxHeight: number; side: Side }

/** A tray card centred on its opener, or a phone sheet centred on the column, inside the usable visual viewport. */
export function placeTrayCard(anchor: Box, pop: Size, bounds: Box, { sheet = false, column = anchor, margin = 12, gap = 12, avoid = [] as Box[] } = {}) {
  const maxWidth = Math.max(0, bounds.width - margin * 2)
  let maxHeight = Math.max(0, bounds.height - margin * 2)
  const width = Math.min(pop.width, maxWidth), height = Math.min(pop.height, maxHeight)
  const local = { ...anchor, left: anchor.left - bounds.left, top: anchor.top - bounds.top + (anchor.height - height) / 2 }
  const beside = placePopover(local, { width, height }, bounds, { beside: true, margin, gap })
  const centre = column.top + column.height / 2 - height / 2
  const left = sheet ? bounds.left + (bounds.width - width) / 2 : bounds.left + beside.left
  let top = sheet ? Math.max(bounds.top + margin, Math.min(centre, bounds.top + bounds.height - margin - height)) : bounds.top + beside.top
  const blocked = avoid.filter(r => r.left < left + width && r.left + r.width > left).map((r): [number, number] => [r.top - gap, r.top + r.height + gap])
  if (blocked.length) {
    const start = bounds.top + margin, end = bounds.top + bounds.height - margin
    maxHeight = Math.max(0, ...freeSpans(start, end, blocked).map(([a, b]) => b - a))
    const fit = Math.min(height, maxHeight)
    top = edgeSpot(top + height / 2, fit, start, end, blocked) - fit / 2
  }
  return {
    left, top,
    maxWidth, maxHeight,
  }
}

/**
 * Below the anchor, or above it when there's more room there and too little below, its start (or end) edge on the
 * anchor's; `beside`: to its right, or left when there's more room there and too little on the right, its top on the
 * anchor's. It keeps `margin` from the frame's edges, and `maxHeight` is the room it has on the chosen side.
 */
export function placePopover(anchor: Box, pop: Size, frame: Size, { beside = false, gap = 6, margin = 8, align = 'start' as 'start' | 'end' } = {}): Placement {
  const x = (at: number) => Math.round(Math.max(margin, Math.min(at, frame.width - margin - pop.width)))
  if (beside) {
    const right = frame.width - margin - (anchor.left + anchor.width + gap)
    const left = anchor.left - gap - margin
    const side: Side = right >= pop.width || right >= left ? 'right' : 'left'
    const room = Math.max(0, frame.height - 2 * margin)
    const height = Math.min(pop.height, room)
    const top = Math.max(margin, Math.min(anchor.top, frame.height - margin - height))
    const at = side === 'right' ? anchor.left + anchor.width + gap : anchor.left - gap - pop.width
    return { left: x(at), top: Math.round(top), maxHeight: Math.floor(room), side }
  }
  const below = frame.height - margin - (anchor.top + anchor.height + gap)
  const above = anchor.top - gap - margin
  const side: Side = below >= pop.height || below >= above ? 'below' : 'above'
  const room = Math.max(0, side === 'below' ? below : above)
  const height = Math.min(pop.height, room)
  const top = side === 'below' ? anchor.top + anchor.height + gap : anchor.top - gap - height
  return { left: x(align === 'end' ? anchor.left + anchor.width - pop.width : anchor.left), top: Math.round(top), maxHeight: Math.floor(room), side }
}

/**
 * Where something that lives on a screen edge goes along it (the quick-actions tray, ../quick.ts): its middle as near
 * `want` as it can be with all `need` px of it clear of every blocked span, inside [start, end]; `want` itself, kept
 * inside, when nowhere is clear.
 */
export function edgeSpot(want: number, need: number, start: number, end: number, blocked: readonly (readonly [number, number])[]): number {
  const half = need / 2
  let best: number | null = null
  for (const [a, b] of freeSpans(start, end, blocked)) {
    if (b - a < need) continue
    const c = Math.max(a + half, Math.min(b - half, want))
    if (best === null || Math.abs(c - want) < Math.abs(best - want)) best = c
  }
  return best ?? Math.max(start + half, Math.min(end - half, want))
}

/** The stretches of [start, end] that no blocked span covers, in order. */
export function freeSpans(start: number, end: number, blocked: readonly (readonly [number, number])[]): [number, number][] {
  const spans = [...blocked].filter(([a, b]) => b > start && a < end).sort((p, q) => p[0] - q[0])
  const free: [number, number][] = []
  let at = start
  for (const [a, b] of spans) { if (a > at) free.push([at, Math.min(a, end)]); at = Math.max(at, b) }
  if (at < end) free.push([at, end])
  return free
}

export interface Frame {
  /** An element's box in the frame. */
  rect(el: Element): Box
  /** The frame's size. */
  size(): Size
}

const viewport: Frame = {
  rect: (el) => el.getBoundingClientRect(),
  size: () => ({ width: innerWidth, height: innerHeight }),
}
let frame: Frame = viewport

/** Measure popovers in a page's own frame (null: the viewport again). */
export function setPopoverFrame(f: Frame | null) { frame = f ?? viewport }
export const popoverFrame = (): Frame => frame
