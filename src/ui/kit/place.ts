/**
 * Where a popover goes: next to what opened it, inside the frame it lives in. The frame is the viewport, unless a page
 * turns its UI against the viewport (the phone controller locks its orientation that way, ../../controller/uiframe.ts):
 * then it says how to measure in its own frame with setPopoverFrame(). The placement itself is pure.
 */

export interface Box { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }
export type Side = 'below' | 'above' | 'right' | 'left'
export interface Placement { left: number; top: number; maxHeight: number; side: Side }

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
