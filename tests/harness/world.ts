/**
 * The hero's world for the physics harness: ../../src/landing/world.ts itself (the letters, the camera, the walls, the
 * raised things, the marbles' steps), laid out as the page lays it out in a real browser (./layouts.json: the headline's
 * lines and box, the raised things' boxes, the play area, per screen), so every scenario runs on what a person sees.
 */
import { createWorld, ORB_R, PAD_ID, type PadRect, type World } from '../../src/landing/world'
import layouts from './layouts.json'

export { ORB_R, PAD_ID }

export interface Layout {
  W: number
  H: number
  lines: string[]
  box: { x: number; y: number; w: number; h: number }
  pads: (PadRect & { text?: string })[]
  play: { top: number; bottom: number }
  dpr: number
  coarse: boolean
}
export const LAYOUTS = layouts as unknown as Record<string, Layout>

export interface Harness {
  world: World
  layout: Layout
  /** Canvas px per em near a floor point (for reading distances as pixels). */
  pxPerEm(x: number, z: number): number
  /** A raised thing's index by (part of) its text, and one of the three steps' icons (by its place: 0, 1, 2). */
  pad(text: RegExp): number
  icon(n: number): number
}

/**
 * The world for a layout (by name, or given), or with other lines in place of the headline's, fitted into another box
 * (a glyph on its own in a box its size on the page: about 100 px an em).
 */
export function buildWorld(name: string | Layout, lines?: string[], box?: Layout['box']): Harness {
  const layout = typeof name === 'string' ? LAYOUTS[name] : name
  if (!layout) throw new Error(`no layout ${String(name)}`)
  const world = createWorld()
  world.layout(lines ?? layout.lines, layout.W, layout.H, box ?? layout.box)
  world.setPads(layout.pads.map(({ x, y, w, h, r }) => ({ x, y, w, h, r })))
  world.play(layout.play.top, layout.play.bottom)
  return {
    world,
    layout,
    pxPerEm(x, z) {
      const a = world.project(x - 0.05, ORB_R, z), b = world.project(x + 0.05, ORB_R, z)
      return Math.hypot(b.x - a.x, b.y - a.y) / 0.1
    },
    pad(text) {
      const i = layout.pads.findIndex((p) => p.w > 0 && text.test(p.text ?? ''))
      if (i < 0) throw new Error(`no raised thing ${text}`)
      return i
    },
    icon(n) {
      const icons = layout.pads.map((p, i) => ({ p, i })).filter(({ p }) => p.w > 0 && p.w < 40 && !p.text)
      if (!icons[n]) throw new Error(`no step icon ${n}`)
      return icons[n].i
    },
  }
}
