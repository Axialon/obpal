/**
 * Telemetry: a device's live readout as an instrument rather than a line of text. Every sim's unit already says how it's
 * doing in words ("42 km/h · 3 laps · gate 2/8"); parseReadout() reads those parts, and Telemetry shows the first
 * measurement as a dot-matrix value with its unit, the rest as small stats, a fraction or a percentage as a capsule
 * gauge, and words as a status dot. Assistive tech reads the sentence as written. Parsing is pure.
 */
import { CapsuleGauge } from './gauge'
import { Readout } from './readout'
import type { Tone } from './status'
import '../../styles/kit.css'

export type TelePart =
  /** A measurement: its number (as shown), its unit, and a word before it ("best", "gate") if any. */
  | { kind: 'metric'; value: string; unit: string; label: string }
  /** A part of a whole: "3/8 keys", "gate 3/8". */
  | { kind: 'ratio'; a: number; b: number; label: string }
  /** A share: "78% open". */
  | { kind: 'percent'; value: number; label: string }
  /** Words: a state ("Landed", "Recording"), toned for its status dot. */
  | { kind: 'status'; text: string; tone: Tone }
  /** Something someone is typing, quoted. */
  | { kind: 'quote'; text: string }

const NUM = '-?\\d+(?:\\.\\d+)?'
const QUOTE = /^[“"‘'](.*)[”"’']$/
const PERCENT = new RegExp(`^(${NUM})\\s*%\\s*(.*)$`)
const RATIO = new RegExp(`^(?:(.*?)\\s+)?(${NUM})\\s*/\\s*(${NUM})(?:\\s+(.*))?$`)
const RANK = /^#(\d+)$/
/** Units drawn in the dot matrix with their number. */
const SIGNS = new Set(['°', '×', '%'])
const LABELLED = new RegExp(`^([A-Za-z][A-Za-z ]*?)\\s+(${NUM})\\s*(.*)$`)
const METRIC = new RegExp(`^(${NUM})\\s*(.*)$`)

/** A status word's tone: recording, a problem, at rest, done, or live. */
export function toneOf(text: string): Tone {
  const t = text.toLowerCase()
  if (/\brec(ording)?\b|playback/.test(t)) return 'rec'
  if (/off track|put back|missed|stopped|fault/.test(t)) return 'warn'
  if (/^(ready|landed|docked|standing|sitting|idle|off|fan off|tv off|pull to launch|straight|empty bucket)$/.test(t)) return 'idle'
  if (/charging|finished|all found|full bucket|won/.test(t)) return 'ok'
  return 'live'
}

/** The parts of a readout, split at " · " as every device writes them. */
export function parseReadout(text: string): TelePart[] {
  return text.split(/\s+·\s+/).map((raw) => raw.trim()).filter(Boolean).map((s): TelePart => {
    let m: RegExpMatchArray | null
    if ((m = s.match(QUOTE))) return { kind: 'quote', text: m[1] }
    if ((m = s.match(PERCENT))) return { kind: 'percent', value: Math.max(0, Math.min(1, Number(m[1]) / 100)), label: m[2].trim() }
    if ((m = s.match(RATIO)) && Number(m[3]) > 0) return { kind: 'ratio', a: Number(m[2]), b: Number(m[3]), label: (m[1] || m[4] || '').trim() }
    if ((m = s.match(RANK))) return { kind: 'metric', value: `#${m[1]}`, unit: 'place', label: '' }
    if ((m = s.match(METRIC))) return { kind: 'metric', value: m[1], unit: m[2].trim(), label: '' }
    if ((m = s.match(LABELLED))) {
      const label = m[1].trim()
      if (/^rec$/i.test(label)) return { kind: 'metric', value: m[2], unit: m[3].trim(), label: 'REC' }
      return { kind: 'metric', value: m[2], unit: m[3].trim(), label }
    }
    return { kind: 'status', text: s, tone: toneOf(s) }
  })
}

/** Which part leads: the first measurement, else the first gauge, else the first words. */
export function leadOf(parts: readonly TelePart[]): number {
  const i = parts.findIndex((p) => p.kind === 'metric')
  if (i >= 0) return i
  const g = parts.findIndex((p) => p.kind === 'ratio' || p.kind === 'percent')
  return g >= 0 ? g : parts.length ? 0 : -1
}

/** Whether two readings share a shape, so the instrument updates in place rather than rebuilding. */
export const sameShape = (a: readonly TelePart[], b: readonly TelePart[]) =>
  a.length === b.length && a.every((p, i) => p.kind === b[i].kind && (p.kind !== 'metric' || (p.unit === (b[i] as typeof p).unit && p.label === (b[i] as typeof p).label)))

/** A unit's live readout as an instrument; set `value` with the device's readout string. */
export class Telemetry {
  readonly el: HTMLSpanElement
  private parts: TelePart[] = []
  private text = ''
  private readonly sr: HTMLSpanElement
  private readonly face: HTMLSpanElement
  private update: ((parts: readonly TelePart[]) => void) | null = null

  constructor(value = '', private opts: { pitch?: number } = {}) {
    const el = this.el = document.createElement('span')
    el.className = 'tele'
    this.sr = document.createElement('span')
    this.sr.className = 'kit-sr'
    this.face = document.createElement('span')
    this.face.className = 'tele-face'
    this.face.setAttribute('aria-hidden', 'true')
    el.append(this.face, this.sr)
    this.value = value
  }

  get value() { return this.text }
  set value(text: string) {
    if (text === this.text) return
    this.text = text
    this.sr.textContent = text
    const parts = parseReadout(text)
    if (this.update && sameShape(parts, this.parts)) { this.parts = parts; this.update(parts); return }
    this.parts = parts
    this.build(parts)
  }

  private build(parts: readonly TelePart[]) {
    const lead = leadOf(parts)
    const updates: ((p: TelePart) => void)[] = []
    const main = document.createElement('span')
    main.className = 'tele-main'
    const more = document.createElement('span')
    more.className = 'tele-more'
    parts.forEach((p, i) => {
      const home = i === lead ? main : more
      if (p.kind === 'metric') {
        if (i === lead) {
          // A one-sign unit (degrees, times) is drawn with the number; a word stands beside it in small caps.
          const sign = (q: TelePart) => q.kind === 'metric' && SIGNS.has(q.unit) ? q.unit : ''
          const r = new Readout({ value: p.value + sign(p), pitch: this.opts.pitch ?? 3 })
          const unit = document.createElement('small')
          unit.className = 'tele-unit'
          unit.textContent = [p.label, sign(p) ? '' : p.unit].filter(Boolean).join(' ')
          if (p.label === 'REC') main.dataset.rec = 'true'
          home.append(r.el, unit)
          updates[i] = (q) => { r.value = (q as typeof p).value + sign(q) }
        } else {
          const stat = document.createElement('span')
          stat.className = 'tele-stat'
          const b = document.createElement('b'), small = document.createElement('small')
          small.textContent = [p.label, p.unit].filter(Boolean).join(' ')
          if (p.label === 'REC') stat.dataset.rec = 'true'
          stat.append(b, small)
          home.append(stat)
          updates[i] = (q) => { b.textContent = (q as typeof p).value }
        }
      } else if (p.kind === 'ratio' || p.kind === 'percent') {
        const g = document.createElement('span')
        g.className = 'tele-gauge'
        const share = (q: TelePart) => q.kind === 'ratio' ? q.a / q.b : q.kind === 'percent' ? q.value : 0
        const words = (q: TelePart) => q.kind === 'ratio' ? `${q.a}/${q.b}${q.label ? ` ${q.label}` : ''}` : q.kind === 'percent' ? `${Math.round(q.value * 100)}%${q.label ? ` ${q.label}` : ''}` : ''
        const cap = new CapsuleGauge({ label: words(p), value: share(p) })
        const small = document.createElement('small')
        g.append(cap.el, small)
        home.append(g)
        updates[i] = (q) => { cap.value = share(q); small.textContent = words(q) }
      } else if (p.kind === 'status') {
        const s = document.createElement('span')
        s.className = 'kit-status tele-status'
        const dot = document.createElement('i'), t = document.createElement('span')
        dot.className = 'kit-dot'
        s.append(dot, t)
        home.append(s)
        updates[i] = (q) => { const st = q as Extract<TelePart, { kind: 'status' }>; s.dataset.tone = st.tone; t.textContent = st.text }
      } else {
        const q = document.createElement('q')
        q.className = 'tele-quote'
        home.append(q)
        updates[i] = (x) => { q.textContent = (x as Extract<TelePart, { kind: 'quote' }>).text }
      }
      updates[i](p)
    })
    this.face.replaceChildren(main, ...(more.childElementCount ? [more] : []))
    this.update = (next) => next.forEach((p, i) => updates[i]?.(p))
  }
}
