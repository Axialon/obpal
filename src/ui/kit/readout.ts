/**
 * Instrument readouts. The dot-matrix readout draws a value as lit dots on a faint 5×7 grid per character, as an LED
 * panel does (the kit's own face: digits, capitals and the signs readouts use), in the accent by default; assistive
 * tech reads the plain text. The sparkline draws a short series as a line with its last point marked. Layout is pure.
 */
import '../../styles/kit.css'

const SVG = 'http://www.w3.org/2000/svg'

/** Each character as seven rows of five dots, the leftmost dot the highest bit. */
export const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  A: [0b01110, 0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 0b11111, 0, 0, 0],
  '+': [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
  '.': [0, 0, 0, 0, 0, 0b01100, 0b01100],
  ',': [0, 0, 0, 0, 0b01100, 0b00100, 0b01000],
  ':': [0, 0b01100, 0b01100, 0, 0b01100, 0b01100, 0],
  '%': [0b11000, 0b11001, 0b00010, 0b00100, 0b01000, 0b10011, 0b00011],
  '°': [0b01100, 0b10010, 0b10010, 0b01100, 0, 0, 0],
  '/': [0, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0],
  '×': [0, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0],
  '#': [0b01010, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0b01010],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
  '?': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0, 0b00100],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  '=': [0, 0, 0b11111, 0, 0b11111, 0, 0],
  '_': [0, 0, 0, 0, 0, 0, 0b11111],
  '·': [0, 0, 0, 0b00100, 0, 0, 0],
}

/** The rows for a character: lower case as capitals, anything unknown as a blank. */
export function glyphRows(ch: string): readonly number[] {
  return GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS[' ']
}

/** Characters that take only the columns they light (punctuation); the rest, digits above all, keep five. */
const TIGHT = new Set(['.', ',', ':', '!', '(', ')', '·', '°', ' '])

export interface DotLayout {
  /** Width and height in dot columns and rows. */
  cols: number
  rows: number
  /** [column, row] of each lit dot, and of each dark one. */
  lit: [number, number][]
  dark: [number, number][]
}

/** Lay `text` out on the dot grid: each character's columns, then a dark column between characters. */
export function dotLayout(text: string): DotLayout {
  const lit: [number, number][] = [], dark: [number, number][] = []
  let x = 0
  const chars = [...text]
  chars.forEach((ch, n) => {
    const rows = glyphRows(ch)
    let cols = [0, 1, 2, 3, 4]
    if (TIGHT.has(ch)) {
      const used = cols.filter((c) => rows.some((r) => r & (1 << (4 - c))))
      cols = ch === ' ' ? [0, 1] : used.length ? cols.slice(Math.min(...used), Math.max(...used) + 1) : [0]
    }
    cols.forEach((c, i) => {
      for (let y = 0; y < 7; y++) (rows[y] & (1 << (4 - c)) ? lit : dark).push([x + i, y])
    })
    x += cols.length
    if (n < chars.length - 1) { for (let y = 0; y < 7; y++) dark.push([x, y]); x += 1 }
  })
  return { cols: x, rows: 7, lit, dark }
}

/** Dots at `pitch` px apart as one path of circles of radius `r` (one element however many dots). */
export function dotPath(points: readonly [number, number][], pitch: number, r: number): string {
  const d = (v: number) => +v.toFixed(2)
  return points.map(([c, y]) => {
    const cx = c * pitch + pitch / 2, cy = y * pitch + pitch / 2
    return `M${d(cx - r)} ${d(cy)}a${d(r)} ${d(r)} 0 1 0 ${d(2 * r)} 0a${d(r)} ${d(r)} 0 1 0 ${d(-2 * r)} 0`
  }).join('')
}

export interface ReadoutOptions {
  value: string | number
  /** What assistive tech reads, if not the value as shown (a unit spelt out, say). */
  label?: string
  /** A small caps unit after the dots. */
  unit?: string
  /** Space between dot centres, px (the readout is seven of these tall). */
  pitch?: number
}

/** A dot-matrix readout; set `value` to change what it shows. */
export class Readout {
  readonly el: HTMLSpanElement
  private readonly svg: SVGSVGElement
  private readonly on: SVGPathElement
  private readonly off: SVGPathElement
  private readonly text: HTMLSpanElement
  private readonly unit: HTMLSpanElement | null = null
  private shown = ''

  constructor(private opts: ReadoutOptions) {
    const el = this.el = document.createElement('span')
    el.className = 'kit-readout'
    const svg = this.svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('class', 'kit-dots')
    svg.setAttribute('aria-hidden', 'true')
    this.off = document.createElementNS(SVG, 'path')
    this.off.setAttribute('class', 'off')
    this.on = document.createElementNS(SVG, 'path')
    this.on.setAttribute('class', 'on')
    svg.append(this.off, this.on)
    this.text = document.createElement('span')
    this.text.className = 'kit-sr'
    el.append(svg, this.text)
    if (opts.unit) {
      this.unit = document.createElement('span')
      this.unit.className = 'kit-readout-unit'
      this.unit.setAttribute('aria-hidden', 'true')
      this.unit.textContent = opts.unit
      el.append(this.unit)
    }
    this.value = opts.value
  }

  set value(v: string | number) {
    const s = String(v)
    if (s === this.shown) return
    this.shown = s
    const pitch = this.opts.pitch ?? 4
    const layout = dotLayout(s)
    const r = pitch * 0.36
    this.svg.setAttribute('viewBox', `0 0 ${layout.cols * pitch} ${7 * pitch}`)
    this.svg.setAttribute('width', String(layout.cols * pitch))
    this.svg.setAttribute('height', String(7 * pitch))
    this.on.setAttribute('d', dotPath(layout.lit, pitch, r))
    this.off.setAttribute('d', dotPath(layout.dark, pitch, r))
    this.text.textContent = this.opts.label ? `${s} ${this.opts.label}` : `${s}${this.opts.unit ? ` ${this.opts.unit}` : ''}`
  }
  get value() { return this.shown }
}

/** A series as a line across `width` × `height` with `pad` px kept clear: the path's d, and its last point. */
export function sparkPath(values: readonly number[], width: number, height: number, pad = 2): { d: string; last: [number, number] | null } {
  if (!values.length) return { d: '', last: null }
  const lo = Math.min(...values), hi = Math.max(...values)
  const span = hi - lo || 1
  const x = (i: number) => pad + (values.length > 1 ? (i / (values.length - 1)) * (width - 2 * pad) : (width - 2 * pad) / 2)
  const y = (v: number) => height - pad - ((v - lo) / span) * (height - 2 * pad)
  const pts = values.map((v, i) => [+x(i).toFixed(2), +y(v).toFixed(2)] as [number, number])
  return { d: pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px} ${py}`).join(''), last: pts[pts.length - 1] }
}

/** A sparkline: a short series drawn as a line, its latest point lit. `label` names it for assistive tech. */
export class Sparkline {
  readonly el: SVGSVGElement
  private readonly line: SVGPathElement
  private readonly dot: SVGCircleElement
  constructor(private opts: { label: string; values: readonly number[]; width?: number; height?: number }) {
    const w = opts.width ?? 96, h = opts.height ?? 28
    const svg = this.el = document.createElementNS(SVG, 'svg')
    svg.setAttribute('class', 'kit-spark')
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', opts.label)
    this.line = document.createElementNS(SVG, 'path')
    this.line.setAttribute('fill', 'none')
    this.dot = document.createElementNS(SVG, 'circle')
    this.dot.setAttribute('r', '2.6')
    svg.append(this.line, this.dot)
    this.values = opts.values
  }
  set values(values: readonly number[]) {
    const { d, last } = sparkPath(values, this.opts.width ?? 96, this.opts.height ?? 28, 3)
    this.line.setAttribute('d', d)
    this.dot.setAttribute('cx', String(last?.[0] ?? -10))
    this.dot.setAttribute('cy', String(last?.[1] ?? -10))
  }
}
