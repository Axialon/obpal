/** Window geometry in CSS pixels, independent of the DOM and storage availability. */
export interface Rect { x: number; y: number; w: number; h: number }
export interface Limits { minW: number; minH: number; maxW?: number; maxH?: number }
export type PanelState = 'open' | 'minimised' | 'closed'
/** `fit`: the window keeps the height its content needs, until a person sizes it themselves. */
export interface Placement { rect: Rect; state: PanelState; fit?: boolean }
export type ScreenClass = 'portrait' | 'compact' | 'desktop' | 'wide'
export type Anchor = 'controls' | 'camera' | 'scores' | 'arm' | 'station' | 'record' | 'view'
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export const GAP = 12
export const SNAP = 10
export const LIMITS: Limits = { minW: 240, minH: 140 }
const between = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))

export function screenClass(w: number, h: number): ScreenClass {
  return w < 600 && h > w ? 'portrait' : h < 500 || w < 1000 ? 'compact' : w >= 1600 ? 'wide' : 'desktop'
}

/** Minimum sizes yield to the available screen; a rotated window can always be reached. */
export function clampRect(rect: Rect, area: Rect, limits: Limits = LIMITS): Rect {
  const w = between(rect.w, Math.min(limits.minW, area.w), Math.min(limits.maxW ?? area.w, area.w))
  const h = between(rect.h, Math.min(limits.minH, area.h), Math.min(limits.maxH ?? area.h, area.h))
  return { x: between(rect.x, area.x, area.x + area.w - w), y: between(rect.y, area.y, area.y + area.h - h), w, h }
}

function closest(value: number, targets: readonly number[], threshold: number) {
  let result = value, distance = threshold + Number.EPSILON
  for (const target of targets) if (Math.abs(target - value) < distance) { distance = Math.abs(target - value); result = target }
  return result
}

/** Snap aligned edges and neighbours with a small gutter, only when their spans meet. */
export function snapMove(rect: Rect, area: Rect, others: readonly Rect[], threshold = SNAP): Rect {
  const xs = [area.x, area.x + area.w - rect.w], ys = [area.y, area.y + area.h - rect.h]
  for (const p of others) {
    if (rect.y <= p.y + p.h + GAP + threshold && rect.y + rect.h >= p.y - GAP - threshold) xs.push(p.x, p.x + p.w - rect.w, p.x + p.w + GAP, p.x - rect.w - GAP)
    if (rect.x <= p.x + p.w + GAP + threshold && rect.x + rect.w >= p.x - GAP - threshold) ys.push(p.y, p.y + p.h - rect.h, p.y + p.h + GAP, p.y - rect.h - GAP)
  }
  return { ...rect, x: closest(rect.x, xs, threshold), y: closest(rect.y, ys, threshold) }
}

/** Resize from the selected edges, retaining the opposite edge even at a size limit. */
export function resizeRect(start: Rect, edge: Edge, dx: number, dy: number, area: Rect, limits = LIMITS, others: readonly Rect[] = [], threshold = SNAP): Rect {
  let left = start.x, top = start.y, right = start.x + start.w, bottom = start.y + start.h
  const xs = [area.x, area.x + area.w], ys = [area.y, area.y + area.h]
  for (const p of others) {
    if (top < p.y + p.h + GAP && bottom > p.y - GAP) xs.push(p.x, p.x + p.w, p.x - GAP, p.x + p.w + GAP)
    if (left < p.x + p.w + GAP && right > p.x - GAP) ys.push(p.y, p.y + p.h, p.y - GAP, p.y + p.h + GAP)
  }
  const minW = Math.min(limits.minW, area.w), minH = Math.min(limits.minH, area.h)
  const maxW = Math.min(limits.maxW ?? area.w, area.w), maxH = Math.min(limits.maxH ?? area.h, area.h)
  if (edge.includes('w')) left = between(closest(left + dx, xs, threshold), Math.max(area.x, right - maxW), right - minW)
  if (edge.includes('e')) right = between(closest(right + dx, xs, threshold), left + minW, Math.min(area.x + area.w, left + maxW))
  if (edge.includes('n')) top = between(closest(top + dy, ys, threshold), Math.max(area.y, bottom - maxH), bottom - minH)
  if (edge.includes('s')) bottom = between(closest(bottom + dy, ys, threshold), top + minH, Math.min(area.y + area.h, top + maxH))
  return clampRect({ x: left, y: top, w: right - left, h: bottom - top }, area, limits)
}

/**
 * A window that fits its content: `natural` px high where there's room, and no taller than the space below its top (or
 * above its bottom, for a window that stands on the bottom edge, which keeps that edge where it is).
 */
export function fitHeight(rect: Rect, natural: number, area: Rect, limits: Limits = LIMITS, keepBottom = false): Rect {
  const bottom = rect.y + rect.h
  const room = keepBottom ? bottom - area.y : area.y + area.h - rect.y
  const h = Math.round(between(natural, Math.min(limits.minH, room), Math.min(limits.maxH ?? room, room)))
  return keepBottom ? { ...rect, y: bottom - h, h } : { ...rect, h }
}

/** Deliberate starting places leave the middle of the stage clear. Phones start docked. */
export function defaultPlacement(anchor: Anchor, index: number, area: Rect, kind: ScreenClass): Placement {
  const small = kind === 'portrait' || kind === 'compact'
  let w = anchor === 'camera' || anchor === 'view' ? (kind === 'wide' ? 360 : 300) : anchor === 'controls' ? (kind === 'wide' ? 352 : 336) : anchor === 'arm' ? 336 : 320
  let h = anchor === 'controls' ? 560 : anchor === 'camera' || anchor === 'view' ? Math.round(w * 9 / 16) + 40 : anchor === 'arm' ? 360 : anchor === 'scores' ? 240 : anchor === 'station' ? 140 : 190
  if (small) { w = kind === 'portrait' ? area.w : 300; h = Math.min(h, kind === 'portrait' ? 440 : area.h) }
  w = Math.min(w, area.w); h = Math.min(h, area.h)
  let x = area.x, y = area.y
  if (anchor === 'camera' || anchor === 'view' || anchor === 'arm' || anchor === 'station') { x = area.x + area.w - w; y += index * (h + GAP) }
  if (anchor === 'scores') { x += Math.max(0, (area.w - w) / 2); y += area.h - h }
  if (kind === 'portrait' && anchor !== 'view') y = area.y + area.h - h
  const docked = small || anchor === 'record' || anchor === 'station' && index > 0 || (index > 0 && y + h > area.y + area.h)
  return { rect: clampRect({ x, y, w, h }, area), state: docked ? 'minimised' : 'open', fit: anchor !== 'camera' }
}

export interface LayoutStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export type Layout = Record<string, Placement>
export function layoutKey(sim: string, kind: ScreenClass) { return `obpal.panels.v1:${encodeURIComponent(sim)}:${kind}` }

/** Reject stale versions, malformed geometry and unknown state without losing other valid windows. */
export function readLayout(storage: LayoutStorage | null, key: string): Layout {
  const result: Layout = Object.create(null)
  try {
    const saved = JSON.parse(storage?.getItem(key) ?? 'null')
    if (saved?.version !== 1 || !saved.panels || typeof saved.panels !== 'object' || Array.isArray(saved.panels)) return result
    for (const [id, p] of Object.entries(saved.panels).slice(0, 64)) {
      const value = p as Placement
      if (!/^[a-z0-9-]{1,64}$/.test(id) || !value?.rect || !['open', 'minimised', 'closed'].includes(value.state)) continue
      const { x, y, w, h } = value.rect
      if (![x, y, w, h].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100_000) || w <= 0 || h <= 0) continue
      result[id] = { rect: { x, y, w, h }, state: value.state, ...(typeof value.fit === 'boolean' ? { fit: value.fit } : {}) }
    }
  } catch { /* Unavailable or corrupt storage does not affect the scene. */ }
  return result
}
export function writeLayout(storage: LayoutStorage | null, key: string, panels: Layout) {
  try { storage?.setItem(key, JSON.stringify({ version: 1, panels })) } catch { /* Private browsing or full storage. */ }
}
export function clearLayout(storage: LayoutStorage | null, key: string) {
  try { storage?.removeItem(key) } catch { /* The in-memory reset still works. */ }
}
