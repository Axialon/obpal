/**
 * ob.Pal's QR code: uqr's matrix drawn in the brand. Round dots, finder squares as rounded boxes with an
 * accent-tinted eye, and the ob.Pal mark in the middle over a cleared circle.
 *
 * Every camera must still read it, so the dark parts stay dark on a light plate whatever colours are asked for:
 * the accent is darkened (in linear light, keeping its hue) until the eyes are nearly as dark as the ink, and ECC
 * 'Q' covers the modules under the mark. The vivid accent goes only where scanning doesn't look: the mark, and
 * around the plate (the pairing chip's glow). tests/qr.test.ts decodes it with two decoders over sizes, surfaces
 * and accents, beside uqr's plain code of the same density. plainQr is the fallback.
 *
 * Each comes as markup (brandedQr, plainQr) or as an element (brandedQrElement, plainQrElement): the pairing chip
 * builds elements, so it works on pages that enforce Trusted Types.
 */
import { encode } from 'uqr'
import { darkenTo, lightenTo, parseColor, toHex, type Rgb } from './color'
import { markNodes } from './mark'
import { svgElement, svgString, type SvgNode } from './svg'

export interface QrStyle {
  /** The code's accent: the eyes (darkened to read as dark) and the mark. Default ob.Pal lime. */
  accent?: string
  /** The modules' colour (darkened as needed). Default near-black. */
  ink?: string
  /** The plate behind the code (lightened as needed). Default white. */
  plate?: string
  /** The ob.Pal mark in the middle. Default true. */
  mark?: boolean
  /** Quiet zone around the code, in modules. Default 3. */
  margin?: number
  /** Error correction: 'Q' (default: room for the mark, and it reads from 2.5 px a module) or 'H' (denser: 3.5 px). */
  ecc?: 'Q' | 'H'
  /** Label for screen readers; without it the SVG is hidden from them (label its container instead). */
  label?: string
}

const LIME: Rgb = [198, 255, 52]
const INK: Rgb = [11, 13, 16]
const WHITE: Rgb = [255, 255, 255]
/**
 * Luminance limits: modules at least 13:1 against the plate, eyes at least 10:1. Lighter eyes (tried down to 6:1)
 * cost decoders reads at small sizes; a finder's eye has to look as dark as its ring.
 */
const INK_MAX = 0.02
const EYE_MAX = 0.04
const PLATE_MIN = 0.85
/** Dot diameter, in modules: round dots with a hair of space between them. */
const DOT = 0.92

/** The colours a code is drawn in, made safe to scan. */
export function qrColors(style: Pick<QrStyle, 'accent' | 'ink' | 'plate'> = {}) {
  const accent = parseColor(style.accent) ?? LIME
  return {
    accent: toHex(accent),
    // A little inside each limit, so rounding to 8-bit channels never crosses it.
    eye: toHex(darkenTo(accent, EYE_MAX * 0.97)),
    ink: toHex(darkenTo(parseColor(style.ink) ?? INK, INK_MAX * 0.97)),
    plate: toHex(lightenTo(parseColor(style.plate) ?? WHITE, PLATE_MIN + 0.005)),
  }
}

const f = (v: number) => String(Math.round(v * 1000) / 1000)

/** A rounded rectangle as a closed subpath (for even-odd rings). */
function box(x: number, y: number, w: number, h: number, r: number): string {
  return `M${f(x + r)} ${f(y)}h${f(w - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(r)}v${f(h - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(r)}h${f(2 * r - w)}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(-r)}v${f(2 * r - h)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-r)}z`
}

/** The branded code, as SVG described in data. */
export function brandedQrNode(text: string, style: QrStyle = {}): SvgNode {
  const qr = encode(text, { ecc: style.ecc ?? 'Q', border: 0 })
  const n = qr.size
  const m = style.margin ?? 3
  const c = qrColors(style)
  const withMark = style.mark !== false
  // The cleared circle: about a quarter of the width, which ECC 'Q' recovers with room to spare.
  const rc = withMark ? Math.round(n * 0.24) / 2 : 0
  const mid = n / 2
  const cleared = (x: number, y: number, pad = 0.2) => withMark && Math.hypot(x + 0.5 - mid, y + 0.5 - mid) < rc + pad
  const finder = (x: number, y: number) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7)
  const ALIGN = 4
  const isAlign = (x: number, y: number) => qr.types[y]?.[x] === ALIGN
  // Alignment patterns: 5 × 5, found by their centre (dark, with the light ring around it).
  const aligns: [number, number][] = []
  for (let y = 2; y < n - 2; y++) {
    for (let x = 2; x < n - 2; x++) {
      if (isAlign(x, y) && qr.data[y][x] && isAlign(x - 2, y - 2) && isAlign(x + 2, y + 2) && !qr.data[y][x + 1] && !qr.data[y + 1][x]) aligns.push([x, y])
    }
  }
  const inAlign = (x: number, y: number) => aligns.some(([ax, ay]) => Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2)

  // Each module a round dot: a zero-length line with round caps, all in one path.
  let dots = ''
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.data[y][x] && !finder(x, y) && !inAlign(x, y) && !cleared(x, y)) dots += `M${x + 0.5} ${y + 0.5}h0`
    }
  }
  let rings = ''
  let eyes = ''
  for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    rings += box(x, y, 7, 7, 2.3) + box(x + 1, y + 1, 5, 5, 1.5)
    eyes += box(x + 2, y + 2, 3, 3, 1.05)
  }
  for (const [x, y] of aligns) {
    if (cleared(x, y, 3)) continue
    rings += box(x - 2, y - 2, 5, 5, 1.5) + box(x - 1, y - 1, 3, 3, 0.8)
    dots += `M${x + 0.5} ${y + 0.5}h0`
  }
  const size = n + 2 * m
  const markSize = rc * 2 * 0.96
  const children: SvgNode[] = [
    ['rect', { x: -m, y: -m, width: size, height: size, rx: f(size * 0.06), fill: c.plate }],
    ['path', { d: dots, fill: 'none', stroke: c.ink, 'stroke-width': DOT, 'stroke-linecap': 'round' }],
    ['path', { d: rings, fill: c.ink, 'fill-rule': 'evenodd' }],
    ['path', { d: eyes, fill: c.eye }],
  ]
  if (withMark) children.push(['g', { transform: `translate(${f(mid - markSize / 2)} ${f(mid - markSize / 2)}) scale(${f(markSize / 100)})` }, markNodes(c.accent)])
  return ['svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: `${-m} ${-m} ${size} ${size}`, ...a11y(style.label), 'shape-rendering': 'geometricPrecision' }, children]
}

const a11y = (label?: string): Record<string, string> => (label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })

/** The branded code as SVG markup. */
export const brandedQr = (text: string, style: QrStyle = {}) => svgString(brandedQrNode(text, style))

/** The branded code as an SVG element (no markup parsed: safe under Trusted Types). */
export const brandedQrElement = (text: string, style: QrStyle = {}, doc: Document = document) => svgElement(brandedQrNode(text, style), doc) as SVGSVGElement

/** The plain code, uqr's matrix as square modules, black on white: the fallback wherever the branded one can't be used. */
export function plainQrNode(text: string, label?: string): SvgNode {
  const qr = encode(text, { ecc: 'M', border: 2 })
  let d = ''
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.data[y][x]) d += `M${x} ${y}h1v1h-1z`
  return ['svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: `0 0 ${qr.size} ${qr.size}`, ...a11y(label), 'shape-rendering': 'crispEdges' }, [
    ['rect', { width: qr.size, height: qr.size, fill: '#fff' }],
    ['path', { d, fill: '#000' }],
  ]]
}

/** The plain code as SVG markup. */
export const plainQr = (text: string, label?: string) => svgString(plainQrNode(text, label))

/** The plain code as an SVG element. */
export const plainQrElement = (text: string, label?: string, doc: Document = document) => svgElement(plainQrNode(text, label), doc) as SVGSVGElement
