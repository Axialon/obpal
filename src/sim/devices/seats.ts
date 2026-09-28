/**
 * Everyone's input, read once a frame the way a device takes it (DeviceInput): the frame, the pad and what went down
 * on it, where a pointing phone points (the Wii-style pointer the arms use), and the buttons, the wheel, typing and
 * recentres that arrived since the last frame. A participant whose input goes quiet for WATCHDOG_MS (the phone went to
 * the background, the network stalled) reads as at rest, so what it drives stops, as the arms' watchdog does; what it
 * pressed still arrives.
 */
import { controllerOf, Mode, type Layout, type Remote } from '@obpal/host'
import { ScreenPointer } from '../../viewer/pointer'
import { restInput, type DeviceInput } from './types'
import type { ControlSession } from '../control-space'

export const WATCHDOG_MS = 300

/** Buttons that send only down and up, no tap: going down is their press. */
const PRESS_ON_DOWN = new Set(['mouse-left', 'mouse-right', 'wii-b'])

interface Seat {
  pointer: ScreenPointer
  pointing: boolean
  held: Set<string>
  presses: string[]
  values: { id: string; v: number | boolean | string }[]
  wheel: number
  text: string
  del: number
  recentred: boolean
  lastInput: number
  padButtons: number
}

/** Typing that arrived as several text{s, del} since the last frame, as one: `del` before `text`. */
export function joinText(a: { text: string; del: number }, s: string, del: number): { text: string; del: number } {
  if (del <= a.text.length) return { text: a.text.slice(0, a.text.length - del) + s, del: a.del }
  return { text: s, del: a.del + del - a.text.length }
}

export class Seats {
  private seats = new Map<string, Seat>()

  constructor(private remote: Remote, private layout: Pick<Layout, 'point'> = {}, private control?: ControlSession) {
    remote.on('input', (who) => { this.seat(who.id).lastInput = performance.now() })
    remote.on('button', ({ id, ev }, who) => {
      const s = this.seat(who.id)
      if (ev === 'down') { s.held.add(id); if (PRESS_ON_DOWN.has(id)) s.presses.push(id) }
      else if (ev === 'up') s.held.delete(id)
      else if (ev === 'tap') s.presses.push(id)
    })
    remote.on('value', ({ id, v }, who) => {
      const s = this.seat(who.id)
      if (id === 'mouse-wheel' && typeof v === 'number' && Number.isFinite(v)) s.wheel += Math.max(-2400, Math.min(2400, v))
      else s.values.push({ id, v })
    })
    remote.on('text', ({ s: typed, del }, who) => {
      const s = this.seat(who.id)
      const t = joinText(s, typed, del)
      s.text = t.text
      s.del = t.del
    })
    remote.on('recenter', (who) => { const s = this.seat(who.id); s.recentred = true; s.pointer.recenter() })
    remote.on('leave', (p) => this.seats.delete(p.id))
  }

  private seat(id: string): Seat {
    let s = this.seats.get(id)
    if (!s) {
      s = { pointer: new ScreenPointer(), pointing: false, held: new Set(), presses: [], values: [], wheel: 0, text: '', del: 0, recentred: false, lastInput: performance.now(), padButtons: 0 }
      this.seats.set(id, s)
    }
    return s
  }

  /**
   * This frame's input from everyone in the scene, by participant id. `spotOf` finds where a participant's pointer on
   * the screen meets the device's floor, for devices that have one.
   */
  read(now: number, spotOf?: (x: number, y: number, who: string) => [number, number] | null): Map<string, DeviceInput> {
    const out = new Map<string, DeviceInput>()
    for (const p of this.remote.participants) {
      const s = this.seat(p.id)
      const f = this.remote.consumeOf(p.id, now)
      // The pad counts while the gamepad is what the phone sends now: a pad left behind stays live for a moment after
      // the phone moves to another controller, and its STATE packets are newer then.
      const pad = f.mode === Mode.gamepad ? this.remote.padOf(p.id) : null
      const mode = f.mode
      const face = p.controller ?? controllerOf(mode, this.layout) ?? 'face.trackpad'
      // The phone recentres its pointing when Point comes on: so does the screen's pointer.
      const pointing = f.connected && mode === Mode.point
      if (pointing && !s.pointing) s.pointer.recenter()
      s.pointing = pointing
      let point: DeviceInput['point'] = null
      if (pointing) {
        // A phone without motion sensors points with its trackpad.
        const st = s.pointer.step(f.aim, [f.pad1[0] * 1.2, f.pad1[1] * 1.2], innerWidth, innerHeight)
        point = { x: st.x, y: st.y, yaw: -s.pointer.aim[0], pitch: s.pointer.aim[1], off: st.off }
      }
      const padPressed = pad ? pad.buttons & ~s.padButtons : 0
      s.padButtons = pad?.buttons ?? 0
      const quiet = now - s.lastInput > WATCHDOG_MS || this.control?.awaitingPosition(p.id)
      const calibrated = this.control?.calibrated(p.id)
      const events = { held: new Set(s.held), presses: s.presses, values: s.values, wheel: s.wheel, text: s.text, del: s.del, recentred: s.recentred && !calibrated, positioned: s.recentred && !!calibrated }
      out.set(p.id, quiet ? { ...restInput(face, mode), ...events, quiet: true, held: new Set() } : {
        face, mode, pad, padPressed,
        touching: f.touching, drag: f.pad1, pan: f.pad2, pinch: f.zoom, twist: f.twist, tilt: f.tilt,
        hold: f.clutch && mode === Mode.hold ? f.qRel : null,
        point, spot: point && spotOf ? spotOf(point.x, point.y, p.id) : null,
        pose: f.pose,
        space: this.control?.aim(p.id, now) ?? undefined, scope: this.control?.scope(p.id),
        ...events,
      })
      s.presses = []
      s.values = []
      s.wheel = 0
      s.text = ''
      s.del = 0
      s.recentred = false
    }
    return out
  }
}
