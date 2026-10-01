import { DOT_SIZES } from '../ui/kit/dot-field'
import type { SpaceDot } from '../ui/kit/dot-space'

/** Stable arc-length samples. Phone, browser and optional PC keep their separate local outlines. */
export function constellationPoints(width = 600, height = 340, pitch: number = DOT_SIZES.base.pitch): SpaceDot[] {
  const points: SpaceDot[] = []
  const line = (x: number, y: number, xx: number, yy: number, role: SpaceDot['role'] = 'light', z = 0) => {
    const count = Math.max(1, Math.ceil(Math.hypot((xx - x) * width, (yy - y) * height) / pitch))
    for (let i = 0; i < count; i++) points.push({ x: x + (xx - x) * i / count, y: y + (yy - y) * i / count, role, z })
  }
  const box = (x: number, y: number, w: number, h: number, role: SpaceDot['role'], z = 0) => {
    const r = Math.min(12, w * width / 4, h * height / 4), rx = r / width, ry = r / height
    line(x + rx, y, x + w - rx, y, role, z)
    line(x + w, y + ry, x + w, y + h - ry, role, z)
    line(x + w - rx, y + h, x + rx, y + h, role, z)
    line(x, y + h - ry, x, y + ry, role, z)
    for (const [cx, cy, start] of [[x + w - rx, y + ry, -Math.PI / 2], [x + w - rx, y + h - ry, 0], [x + rx, y + h - ry, Math.PI / 2], [x + rx, y + ry, Math.PI]]) {
      const count = Math.max(1, Math.ceil(Math.PI * r / (2 * pitch)))
      for (let i = 0; i < count; i++) { const angle = start + Math.PI / 2 * i / count; points.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry, role, z }) }
    }
  }
  box(0.08, 0.25, 0.15, 0.37, 'light', 0.025)
  line(0.12, 0.285, 0.19, 0.285, 'light', 0.025)
  line(0.13, 0.585, 0.18, 0.585, 'light', 0.025)
  box(0.34, 0.29, 0.3, 0.29, 'ink')
  line(0.34, 0.35, 0.64, 0.35, 'ink')
  box(0.77, 0.32, 0.18, 0.22, 'muted', -0.03)
  line(0.86, 0.54, 0.86, 0.60, 'muted', -0.03)
  line(0.815, 0.60, 0.905, 0.60, 'muted', -0.03)
  return points
}

export function constellationRoutes(): SpaceDot[][] {
  return [Array.from({ length: 28 }, (_, i) => { const t = i / 27; return { x: 0.245 + 0.08 * t, y: 0.44 + Math.sin(t * Math.PI) * 0.055, role: 'light' as const } }), Array.from({ length: 16 }, (_, i) => { const t = i / 15; return { x: 0.66 + 0.09 * t, y: 0.44 + Math.sin(t * Math.PI) * 0.035, role: 'muted' as const } })]
}

