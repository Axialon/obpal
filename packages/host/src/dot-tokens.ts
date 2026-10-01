/** Renderer-independent material and motion roles from docs/DOTS.md. Sizes are CSS pixels at focus. */
export type DotRole = 'active' | 'light' | 'ink' | 'muted' | 'depth'
export type DotScale = 'micro' | 'base' | 'display' | 'beacon' | 'seal'
export const DOT_SIZES = {
  micro: { diameter: 1.8, pitch: 8 }, base: { diameter: 3, pitch: 12 },
  display: { diameter: 4.2, pitch: 16 }, beacon: { diameter: 6, pitch: 20 },
  seal: { diameter: 4.2, pitch: 16 },
} as const
export const DOT_TIMING = { assemble: 640, ripple: 480, shimmer: 700, breathe: 6400, stream: 900, partIn: 200, partOut: 320, handshake: 1200, fade: 120 } as const
export const DOT_MATERIAL = { roughness: 0.32, key: 1, rim: 0.35, fill: 0.18, edgeGlow: 0.1, touchRadius: 54, maxTouch: 8, parallaxDegrees: 3 } as const
export interface DotTokens { colors: Record<DotRole, string>; surface: string; diameter: number; pitch: number; scale: DotScale }

/** Chip-local overrides precede family roles; gradients are never accepted as a colour. */
export function resolveDotTokens(element: Element, scale: DotScale = 'base'): DotTokens {
  const style = getComputedStyle(element)
  const color = (fallback: string, ...names: string[]) => names.map(name => {
    const value = style.getPropertyValue(name).trim()
    return /^(?:\d+(?:\.\d+)?\s+){2}\d+(?:\.\d+)?$/.test(value) ? `rgb(${value.split(/\s+/).join(',')})` : value
  }).find(value =>
    value && (typeof CSS === 'undefined' ? !/(?:gradient|url)\(/.test(value) : CSS.supports('color', value)),
  ) || fallback
  const active = color(style.color, '--ob-dot-active', '--a', '--bb-accent-text', '--bb-accent', '--accent')
  const lightSurface = element.closest?.('[data-bb-theme]')?.getAttribute('data-bb-theme') === 'light'
  return {
    scale, ...DOT_SIZES[scale],
    colors: {
      active, light: color(active, '--ob-dot-light', '--a', lightSurface ? '--bb-accent-text' : '--bb-accent', '--accent'),
      ink: color(style.color, '--ob-dot-ink', '--bb-ink-2', '--secondary'),
      muted: color(style.color, '--ob-dot-muted', '--bb-ink-3', '--muted'),
      depth: color(style.color, '--ob-dot-depth', '--haze-rgb', '--bb-aurora', '--bb-ink-3'),
    },
    surface: color('transparent', '--ob-dot-surface', '--s', '--glass', '--bb-surface', '--bb-sheet'),
  }
}

/** Epoch timestamp is transportable; callers still own scheduling and the authenticated seal. */
export interface DotTimeline { startedAt: number; duration: number }
export const dotTimeline = (startedAt: number, duration: number = DOT_TIMING.handshake): DotTimeline => ({ startedAt, duration })
export function dotProgress(timeline: DotTimeline, now: number): number {
  return Number.isFinite(now) && Number.isFinite(timeline.startedAt) && Number.isFinite(timeline.duration) && timeline.duration > 0
    ? Math.max(0, Math.min(1, (now - timeline.startedAt) / timeline.duration)) : 1
}

/** Cubic family curves, evaluated by time rather than by frame count. */
export function dotEase(progress: number, arrival = false): number {
  const x = Math.max(0, Math.min(1, progress))
  const [x1, y1, x2, y2] = arrival ? [0.16, 1, 0.3, 1] : [0.2, 0.8, 0.2, 1]
  const cubic = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3
  let low = 0, high = 1
  for (let i = 0; i < 14; i++) { const t = (low + high) / 2; if (cubic(t, x1, x2) < x) low = t; else high = t }
  return x === 0 || x === 1 ? x : cubic((low + high) / 2, y1, y2)
}
