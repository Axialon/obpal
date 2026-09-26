/**
 * The controller UI's own frame. While the screen is locked by counter-rotating the page (browsers without a native
 * orientation lock, see ./lock.ts), the UI is turned against the viewport by `rotation` degrees about the viewport's
 * centre. Touches arrive in viewport coordinates; controls read them in the UI's frame so a drag "right" stays right.
 */
let rotation = 0

export function setUiRotation(deg: number) { rotation = ((Math.round(deg) % 360) + 360) % 360 }
export function uiRotation() { return rotation }

/** The UI's size: the viewport, turned when the UI is rotated a quarter turn. */
export function uiSize(): { w: number; h: number } {
  return rotation % 180 ? { w: innerHeight, h: innerWidth } : { w: innerWidth, h: innerHeight }
}

/** A viewport point (clientX, clientY) in the UI's frame. */
export function toUi(x: number, y: number): { x: number; y: number } {
  if (!rotation) return { x, y }
  const r = (-rotation * Math.PI) / 180
  const dx = x - innerWidth / 2
  const dy = y - innerHeight / 2
  const { w, h } = uiSize()
  return { x: dx * Math.cos(r) - dy * Math.sin(r) + w / 2, y: dx * Math.sin(r) + dy * Math.cos(r) + h / 2 }
}

/** An element's box in the UI's frame (getBoundingClientRect gives the rotated box's bounds in the viewport). */
export function uiRect(el: Element): { left: number; top: number; width: number; height: number } {
  const r = el.getBoundingClientRect()
  if (!rotation) return { left: r.left, top: r.top, width: r.width, height: r.height }
  const a = toUi(r.left, r.top)
  const b = toUi(r.right, r.bottom)
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}
