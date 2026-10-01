/** Relative thumb gain: 1× through 0.08px/ms, smoothstep to 6× at 0.8px/ms, then capped. */
export function thumbGain(speed: number) {
  const t = Math.max(0, Math.min(1, (speed - .08) / .72))
  return 1 + 5 * t * t * (3 - 2 * t)
}

/** The outer 24px continue at up to 0.9px/ms per axis, after a deliberate move. */
export function thumbEdge(x: number, y: number, width: number, height: number): [number, number] {
  const axis = (p: number, size: number) => {
    const d = p < 24 ? -(24 - p) / 24 : p > size - 24 ? (p - size + 24) / 24 : 0
    return Math.max(-1, Math.min(1, d)) * .9
  }
  return [axis(x, width), axis(y, height)]
}

/** Portrait thumb size and mirrored grid columns. The tray and dock keep their space below it. */
export function thumbRegion(width: number, height: number, left: boolean) {
  const w = Math.min(width - 32, 340)
  const h = Math.min(height * .38, 320)
  return { width: w, height: h, align: left ? 'flex-start' : 'flex-end', primary: left ? '1 / 3' : '2 / 4', auxiliary: left ? '3' : '1' }
}
