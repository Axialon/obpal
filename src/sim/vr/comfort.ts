/** Local comfort choices never change the scene's simulation. */
export interface Comfort { horizon: boolean; vignette: boolean; snap: 15 | 30 | 45 }
export const DEFAULT_COMFORT: Comfort = { horizon: true, vignette: true, snap: 30 }
export function comfort(value: unknown): Comfort {
  const v = value as Partial<Comfort> | null
  return { horizon: typeof v?.horizon === 'boolean' ? v.horizon : true, vignette: typeof v?.vignette === 'boolean' ? v.vignette : true, snap: v?.snap === 15 || v?.snap === 45 ? v.snap : 30 }
}
export const vignetteStrength = (speed: number, turn: number, enabled: boolean) => enabled ? Math.min(0.8, Math.max(0, (speed - 0.5) / 6, (Math.abs(turn) - 0.4) / 4)) : 0

/** Hysteresis avoids changing quality for one late frame or one compositor hiccup. */
export class XRQuality {
  foveation = 0.5
  shadows = true
  private slow = 0
  private fast = 0
  frame(dt: number, hz = 72) {
    if (dt > 1.2 / hz) { this.slow++; this.fast = 0 } else { this.fast++; this.slow = Math.max(0, this.slow - 1) }
    if (this.slow >= 24) { this.foveation = Math.min(1, this.foveation + 0.15); this.shadows = this.foveation < 0.9; this.slow = 0 }
    if (this.fast >= 240) { this.foveation = Math.max(0.35, this.foveation - 0.05); this.shadows = this.foveation < 0.9; this.fast = 0 }
  }
}
