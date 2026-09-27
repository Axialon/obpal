/**
 * The ob.Pal mark, held still and drawn flat so it stays crisp at chip and QR sizes: the obsidian box with its lit
 * edges, and the orbit with its satellite in the accent colour. Geometry in a 100 × 100 box, as public/logo-mark.svg.
 */
import { svgElement, svgString, type SvgNode } from './svg'

/** The mark's shapes, for a 100 × 100 box. */
export function markNodes(accent: string): SvgNode[] {
  const box = '50,19 78,34.4 78,65.2 50,80.6 22,65.2 22,34.4'
  return [
    ['ellipse', { cx: 50, cy: 57, rx: 47, ry: 15, transform: 'rotate(-14 50 57)', fill: 'none', stroke: accent, 'stroke-width': 3, opacity: 0.35 }],
    ['polygon', { points: box, fill: '#050505' }],
    ['polygon', { points: '50,19 78,34.4 50,49.8 22,34.4', fill: '#2f2f2f' }],
    ['polygon', { points: '22,34.4 50,49.8 50,80.6 22,65.2', fill: '#0c0c0c' }],
    ['polygon', { points: '50,49.8 78,34.4 78,65.2 50,80.6', fill: '#191919' }],
    ['polygon', { points: box, fill: 'none', stroke: '#fff', 'stroke-opacity': 0.42, 'stroke-width': 1.6, 'stroke-linejoin': 'round' }],
    ['path', { d: 'M50 49.8V80.6', stroke: '#fff', 'stroke-opacity': 0.3, 'stroke-width': 1.4 }],
    ['path', { d: 'M22 34.4 50 49.8 78 34.4', fill: 'none', stroke: accent, 'stroke-width': 3, 'stroke-linejoin': 'round' }],
    ['path', { d: 'M50 19 78 34.4', stroke: '#fff', 'stroke-opacity': 0.75, 'stroke-width': 1.4, 'stroke-linecap': 'round' }],
    ['path', { d: 'M95.6 45.63A47 15-14 0 1 4.4 68.37', fill: 'none', stroke: accent, 'stroke-width': 4.4, 'stroke-linecap': 'round' }],
    ['circle', { cx: 82.1, cy: 60.8, r: 5.4, fill: accent }],
    ['circle', { cx: 82.1, cy: 60.8, r: 2, fill: '#fff' }],
  ]
}

const markSvgNode = (accent: string): SvgNode => ['svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false' }, markNodes(accent)]

/** The mark as its own SVG markup (decorative: hidden from screen readers). */
export const markSvg = (accent: string) => svgString(markSvgNode(accent))

/** The mark as an SVG element (decorative: hidden from screen readers). */
export const markElement = (accent: string, doc: Document = document) => svgElement(markSvgNode(accent), doc) as SVGSVGElement
