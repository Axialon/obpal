/**
 * Wii-style screen pointer. The phone sends where it points as aim deltas (degrees since its recentre); the
 * cursor is where that ray meets the screen: x = cx + tan(yaw) * K, with K set so POINT_HALF_FOV degrees reach
 * the left/right edge. The point can leave the screen (the host shows an edge arrow) and returns when the phone
 * aims back. A phone without motion sensors steers with its trackpad instead (pixels, converted to the same angle).
 */
export const POINT_HALF_FOV = 16

const D2R = Math.PI / 180
const R2D = 180 / Math.PI
/** Past this angle tan() runs away; the point just stays far off-screen. */
const LIMIT = 75

export interface PointerStep {
  /** Where the phone points, in CSS px (can be off-screen). */
  x: number
  y: number
  /** Motion of that point since the last step (0 on the first step after a recentre). */
  dx: number
  dy: number
  off: boolean
}

export class ScreenPointer {
  /** Degrees since recentre: yaw + = left, pitch + = up. */
  readonly aim: [number, number] = [0, 0]
  private last: { x: number; y: number } | null = null

  recenter() {
    this.aim[0] = this.aim[1] = 0
    this.last = null
  }

  /** Pixels per radian near the centre, for a screen `w` wide. */
  static scale(w: number) { return w / 2 / Math.tan(POINT_HALF_FOV * D2R) }

  step(dAim: readonly [number, number], dPad: readonly [number, number], w: number, h: number): PointerStep {
    const K = ScreenPointer.scale(w)
    this.aim[0] += dAim[0] - (dPad[0] / K) * R2D
    this.aim[1] += dAim[1] - (dPad[1] / K) * R2D
    const lim = (a: number) => Math.max(-LIMIT, Math.min(LIMIT, a)) * D2R
    const x = w / 2 + Math.tan(lim(-this.aim[0])) * K
    const y = h / 2 - Math.tan(lim(this.aim[1])) * K
    const dx = this.last ? x - this.last.x : 0
    const dy = this.last ? y - this.last.y : 0
    this.last = { x, y }
    return { x, y, dx, dy, off: x < 0 || x > w || y < 0 || y > h }
  }
}
