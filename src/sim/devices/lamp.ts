/**
 * Smart lamps: a room at dusk with four lamps, one per phone. The trackpad suits them best: drag across for the colour,
 * up and down for the brightness, twist like a dial, pinch to dim, tap to switch it. The air mouse points at a lamp and
 * Left takes it (then switches it), its wheel dims, and holding the wheel and sweeping paints it; and the phone's
 * keyboard takes words: "teal", "warm 40%", "#ff8800", "off", "party". (The Wii remote's A, B and − + work the same, for
 * a screen whose Point face is the Wii remote: a host offers one of the two.)
 */
import { Controller, Mode } from '@obpal/core'
import { clamp, dialOf } from './input'
import type { DeviceEvent, DeviceInput, DeviceLogic, DeviceSpec } from './types'

export const LAMP_SPEC: DeviceSpec = {
  id: 'lamp',
  name: 'Smart lamps',
  unit: 'Lamp',
  units: 4,
  unitNames: ['Floor lamp', 'Desk lamp', 'Pendant', 'Light bar'],
  kind: 'Home',
  blurb: 'Four lamps in a room at dusk: colour and dim yours, or type what you want.',
  teaches: 'The trackpad as dials, the mouse wheel as a value, and typing as input',
  controllers: [Controller.trackpad, Controller.mouse, Controller.keyboard],
  how: {
    'face.trackpad': 'Drag across: colour · up and down: brightness · twist: colour · tap: on and off',
    'face.mouse': 'Point at a lamp, Left takes it (then switches it) · the wheel dims · hold it and sweep to paint',
    'face.keyboard': 'Type a colour: teal, warm 40%, #ff8800, off, party',
  },
  tray: [
    { id: 'power', label: 'On and off', type: 'button', icon: 'sun' },
    {
      id: 'scene', label: 'Scene', type: 'select',
      options: [
        { value: 'warm', label: 'Warm', color: '#ffb86b' }, { value: 'daylight', label: 'Daylight', color: '#eef4ff' },
        { value: 'focus', label: 'Focus', color: '#dbeafe' }, { value: 'relax', label: 'Relax', color: '#f59e0b' },
        { value: 'party', label: 'Party', color: '#c084fc' },
      ],
    },
  ],
  // A headset press or a keyboard's L switches it.
  buttons: { 'media:playpause': 'tray:power', 'key:KeyL': 'tray:power' },
}

export interface Lamp {
  on: boolean
  /** Hue (degrees), saturation and brightness (0…1). */
  h: number
  s: number
  v: number
  /** Party: the hue goes round by itself. */
  party: boolean
  /** Words typed so far on its keyboard (not yet Enter). */
  typing: string
  /** A colour that's being typed, shown until Enter or Esc. */
  draft: { h?: number; s?: number; v?: number } | null
  /** Painting with B held: the lamp's colour and the aim when B went down. */
  paint: { h: number; v: number; yaw: number; pitch: number } | null
  /** 1:1 dial: the hue when the gyro came on. */
  dial: number | null
}

const HOME_LAMP = { on: true, h: 34, s: 0.55, v: 0.8 }

/** Colours by name; a white is a low saturation at its tint. */
const NAMES: Record<string, { h: number; s: number; v?: number }> = {
  red: { h: 0, s: 0.9 }, orange: { h: 26, s: 0.9 }, amber: { h: 40, s: 0.9 }, gold: { h: 46, s: 0.85 }, yellow: { h: 55, s: 0.85 },
  lime: { h: 80, s: 0.85 }, green: { h: 125, s: 0.8 }, mint: { h: 152, s: 0.55 }, teal: { h: 174, s: 0.8 }, cyan: { h: 186, s: 0.85 },
  sky: { h: 200, s: 0.75 }, blue: { h: 222, s: 0.85 }, indigo: { h: 245, s: 0.75 }, violet: { h: 265, s: 0.7 }, purple: { h: 280, s: 0.75 },
  lavender: { h: 262, s: 0.35 }, magenta: { h: 305, s: 0.85 }, pink: { h: 330, s: 0.55 }, rose: { h: 348, s: 0.7 },
  warm: { h: 34, s: 0.55 }, cool: { h: 212, s: 0.12 }, daylight: { h: 212, s: 0.08, v: 1 },
  candle: { h: 28, s: 0.78, v: 0.45 }, sunset: { h: 16, s: 0.82 }, ocean: { h: 200, s: 0.85 }, forest: { h: 130, s: 0.6 },
}

/** The panel's scenes (the tray's Scene picker). */
const SCENES: Record<string, { h: number; s: number; v: number; party?: boolean }> = {
  warm: { h: 34, s: 0.55, v: 0.8 }, daylight: { h: 212, s: 0.08, v: 1 }, focus: { h: 214, s: 0.18, v: 1 },
  relax: { h: 30, s: 0.8, v: 0.35 }, party: { h: 280, s: 0.9, v: 0.9, party: true },
}

export interface Parsed { on?: boolean; h?: number; s?: number; v?: number; party?: boolean }

/** What a few typed words ask a lamp for: a colour by name or #hex, a brightness (40%, dim, bright), on, off, party. */
export function parseLamp(text: string): Parsed | null {
  const out: Parsed = {}
  const words = text.toLowerCase().replace(/[,.!]/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return null
  for (const w of words) {
    const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(w)
    const pct = /^(\d{1,3})%?$/.exec(w)
    if (w === 'on') out.on = true
    else if (w === 'off') out.on = false
    else if (w === 'party') { out.party = true; out.on = true }
    else if (w === 'dim') out.v = 0.25
    // White is nearly no colour: a warm or cool one keeps a little of its tint.
    else if (w === 'white') { out.h ??= 40; out.s = Math.min(out.s ?? 0.05, 0.3); out.on ??= true }
    else if (w === 'bright') out.v = 1
    else if (NAMES[w]) { Object.assign(out, { h: NAMES[w].h, s: NAMES[w].s }, NAMES[w].v !== undefined ? { v: NAMES[w].v } : {}); out.on ??= true }
    else if (hex && (w.startsWith('#') || /[a-f]/.test(w))) { Object.assign(out, hsvOf(hex[1])); out.on ??= true }
    else if (pct && Number(pct[1]) <= 100) out.v = Number(pct[1]) / 100
    else if (!['light', 'lamp', 'the', 'to', 'please', 'make', 'it', 'set'].includes(w)) return null
  }
  return Object.keys(out).length ? out : null
}

/** A hex colour ("0ff", "ff8800") as hue, saturation and brightness. */
export function hsvOf(hex: string): { h: number; s: number; v: number } {
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let h = 0
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: ((h * 60) + 360) % 360, s: max ? d / max : 0, v: max }
}

/** A lamp's colour right now as RGB (0…1), what its bulb shows; off, it's dark. */
export function rgbOf(l: Lamp): [number, number, number] {
  const c = { h: l.h, s: l.s, v: l.v, ...(l.draft ?? {}) }
  if (!l.on) return [0, 0, 0]
  const f = (n: number) => { const k = (n + c.h / 60) % 6; return c.v * (1 - c.s * Math.max(0, Math.min(k, 4 - k, 1))) }
  return [f(5), f(3), f(1)]
}

/** A lamp's name for its colour, for the panel and a toast. */
export function nameOf(l: Lamp): string {
  if (!l.on) return 'Off'
  if (l.party) return 'Party'
  if (l.s < 0.2) return `${Math.round(l.v * 100)}% white`
  let best = 'red'
  let d = 360
  for (const [name, c] of Object.entries(NAMES)) {
    if (c.s < 0.3) continue
    const dh = Math.abs(((l.h - c.h + 540) % 360) - 180)
    if (dh < d) { d = dh; best = name }
  }
  return `${Math.round(l.v * 100)}% ${best}`
}

export class LampLogic implements DeviceLogic {
  readonly spec = LAMP_SPEC
  readonly lamps: Lamp[]
  private events: DeviceEvent[] = []

  constructor(count = LAMP_SPEC.units) {
    this.lamps = Array.from({ length: count }, () => ({ ...HOME_LAMP, party: false, typing: '', draft: null, paint: null, dial: null }))
  }

  step(inputs: readonly (DeviceInput | null)[], dt: number) {
    this.lamps.forEach((l, n) => {
      const inp = inputs[n]
      if (inp) this.control(l, n, inp, dt)
      else { l.paint = null; l.dial = null }
      if (l.party && l.on) l.h = (l.h + dt * 40) % 360
    })
  }

  private say(n: number, text: string, kind: DeviceEvent['kind'] = 'tick') { this.events.push({ unit: n, kind, text }) }

  private toggle(l: Lamp, n: number) {
    l.on = !l.on
    this.say(n, `${LAMP_SPEC.unitNames![n]} ${l.on ? 'on' : 'off'}`)
  }

  private control(l: Lamp, n: number, inp: DeviceInput, dt: number) {
    const set = (p: Parsed) => {
      if (p.h !== undefined) { l.h = p.h; l.party = false }
      if (p.s !== undefined) l.s = clamp(p.s, 0, 1)
      if (p.v !== undefined) l.v = clamp(p.v, 0.02, 1)
      if (p.party) l.party = true
      if (p.on !== undefined) l.on = p.on
    }
    const dim = (k: number) => { l.v = clamp(l.v + k, 0.02, 1); if (!l.on && k > 0) l.on = true }
    for (const p of inp.presses) {
      if (p === 'power' || (p === 'pad' && inp.mode !== Mode.point)) this.toggle(l, n)
      else if (p === 'wii-a' || p === 'mouse-left') this.toggle(l, n)
      else if (p === 'wii-plus') dim(0.1)
      else if (p === 'wii-minus') dim(-0.1)
      else if (p === 'mouse-right') this.nextScene(l, n)
      else if (p === 'key-Enter') this.submit(l, n)
      else if (p === 'key-Escape') { l.typing = ''; l.draft = null }
      else if (p === 'key-Backspace') { l.typing = l.typing.slice(0, -1); this.preview(l) }
    }
    for (const { id, v } of inp.values) if (id === 'scene' && typeof v === 'string' && SCENES[v]) { set({ ...SCENES[v], on: true }); l.party = !!SCENES[v].party; this.say(n, `${LAMP_SPEC.unitNames![n]}: ${v}`) }
    if (inp.wheel) dim(-inp.wheel / 1200 * 0.5)
    // Typing: the words so far show on the lamp as they're typed; Enter keeps them.
    if (inp.text || inp.del) {
      l.typing = l.typing.slice(0, Math.max(0, l.typing.length - inp.del))
      for (const ch of inp.text) {
        if (ch === '\n') this.submit(l, n)
        else if (l.typing.length < 40) l.typing += ch
      }
      this.preview(l)
    }
    if (inp.space && !inp.pad) {
      // Pointing previews the lamp; holding paints it, leaving wheel and presets at their chosen values.
      if (!inp.point || inp.held.has('wii-b')) {
        const [x, y] = inp.space.aim
        l.h = (x + 1) * 179.9; l.v = 0.02 + (y + 1) * 0.49; l.party = false
      }
      return
    }
    if (inp.point) {
      // B held (or the wheel held, on the mouse): sweep to paint, across for the colour, up and down for the brightness.
      if (inp.held.has('wii-b')) {
        l.paint ??= { h: l.h, v: l.v, yaw: inp.point.yaw, pitch: inp.point.pitch }
        l.h = (((l.paint.h + (inp.point.yaw - l.paint.yaw) * 6) % 360) + 360) % 360
        l.v = clamp(l.paint.v + (inp.point.pitch - l.paint.pitch) * 0.03, 0.02, 1)
        l.party = false
        l.on = true
      } else l.paint = null
      return
    }
    l.paint = null
    if (inp.hold) {
      // 1:1: the phone is a dial; turning it turns the colour round.
      if (l.dial === null) l.dial = l.h - dialOf(inp.hold)
      l.h = ((l.dial + dialOf(inp.hold)) % 360 + 360) % 360
      l.party = false
    } else l.dial = null
    if (inp.drag[0] || inp.drag[1] || inp.twist || inp.pinch || inp.pan[1]) {
      l.h = (((l.h + inp.drag[0] * 0.5 + inp.twist) % 360) + 360) % 360
      l.v = clamp(l.v - inp.drag[1] * 0.004 + inp.pinch * 0.35, 0.02, 1)
      l.s = clamp(l.s - inp.pan[1] * 0.004, 0, 1)
      if (inp.drag[0] || inp.twist) l.party = false
    }
    if (inp.mode === Mode.tilt) {
      l.h = (((l.h + inp.tilt[0] * 70 * dt) % 360) + 360) % 360
      l.v = clamp(l.v - inp.tilt[1] * 0.5 * dt, 0.02, 1)
    }
  }

  private preview(l: Lamp) {
    const p = parseLamp(l.typing)
    l.draft = p && (p.h !== undefined || p.v !== undefined) ? { ...(p.h !== undefined ? { h: p.h, s: p.s } : {}), ...(p.v !== undefined ? { v: p.v } : {}) } : null
  }

  private submit(l: Lamp, n: number) {
    const text = l.typing.trim()
    l.typing = ''
    l.draft = null
    if (!text) return
    const p = parseLamp(text)
    if (!p) { this.say(n, `“${text}”? Try teal, warm 40%, #ff8800, off`, 'bump'); return }
    if (p.h !== undefined) { l.h = p.h; l.party = false }
    if (p.s !== undefined) l.s = p.s
    if (p.v !== undefined) l.v = clamp(p.v, 0.02, 1)
    if (p.party) l.party = true
    if (p.on !== undefined) l.on = p.on
    this.say(n, `${LAMP_SPEC.unitNames![n]}: ${nameOf(l).toLowerCase()}`)
  }

  private nextScene(l: Lamp, n: number) {
    const ids = Object.keys(SCENES)
    const now = ids.findIndex((id) => { const s = SCENES[id]; return Math.abs(s.h - l.h) < 1 && Math.abs(s.v - l.v) < 0.01 })
    const id = ids[(now + 1) % ids.length]
    const s = SCENES[id]
    Object.assign(l, { h: s.h, s: s.s, v: s.v, party: !!s.party, on: true })
    this.say(n, `${LAMP_SPEC.unitNames![n]}: ${id}`)
  }

  /** Home: warm white, on, at 80%. */
  home(n: number) {
    Object.assign(this.lamps[n], HOME_LAMP, { party: false, typing: '', draft: null, paint: null, dial: null })
  }

  readout(n: number) {
    const l = this.lamps[n]
    return l.typing ? `“${l.typing}”` : nameOf(l)
  }

  drain() { const e = this.events; this.events = []; return e }
}
