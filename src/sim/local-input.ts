/** Local controllers produce the same per-frame DeviceInput as a phone's standard gamepad. */
import { emptyPad, PadButton, type PadState, type TrayControl } from '@obpal/core'
import { restInput, type DeviceInput } from './devices/types'
import { clamp, stick } from './devices/input'

export type LocalSource = 'phone' | 'window' | 'touch' | 'keyboard' | 'gamepad'
export interface PadLike { index: number; connected: boolean; mapping: string; axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[] }
const finite = (v: number | undefined) => typeof v === 'number' && Number.isFinite(v) ? clamp(v, -1, 1) : 0
/** Keep the phone's deadzone response: small jitter is zero, other values are read by its existing consumers. */
export function standardPad(p: PadLike): PadState | null {
  if (!p.connected || p.mapping !== 'standard') return null
  const out = emptyPad()
  out.axes = [0, 1, 2, 3].map(n => finite(p.axes[n])) as PadState['axes']
  for (const at of [0, 2]) if (Math.hypot(out.axes[at], out.axes[at + 1]) <= .12) { out.axes[at] = 0; out.axes[at + 1] = 0 }
  p.buttons.slice(0, 17).forEach((b, n) => { if (b.pressed || finite(b.value) > .5) out.buttons |= 1 << n })
  out.triggers = [Math.max(0, finite(p.buttons[6]?.value)), Math.max(0, finite(p.buttons[7]?.value))]
  const d = (b: number) => Number(!!(out.buttons & (1 << b)))
  if (!out.axes[0] && !out.axes[1]) out.axes.splice(0, 2, d(PadButton.Right) - d(PadButton.Left), d(PadButton.Down) - d(PadButton.Up))
  return out
}

export const DEFAULT_BINDINGS: Record<string, string[]> = {
  left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'],
  turnLeft: ['KeyQ'], turnRight: ['KeyE'], lookUp: ['KeyI'], lookDown: ['KeyK'], lookLeft: ['KeyJ'], lookRight: ['KeyL'],
  primary: ['Enter'], secondary: ['KeyB'], third: ['KeyX'], fourth: ['KeyY'], rise: ['Space'], lower: ['ShiftLeft', 'ShiftRight'], home: ['KeyH'],
}

/** Select a source without blending a local action into a unit held by a phone. */
export function chooseInput(phone: DeviceInput | null, claimed: boolean, local: DeviceInput | null): DeviceInput | null {
  return claimed ? phone : local ?? phone
}

/** Local enable never arms a driver. Live hardware additionally requires the controller's held deadman. */
export function liveInput(input: DeviceInput, live: boolean, held: boolean): DeviceInput {
  if (!live || held) return input
  return { ...restInput(input.face, input.mode), pad: input.pad ? emptyPad() : null, presses: input.presses.filter(id => id === 'estop') }
}

export class LocalInput {
  source: LocalSource = 'phone'
  unit = 0
  armed = false
  bindings = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([id, codes]) => [id, [...codes]]))
  readonly keys = new Set<string>()
  private before = new Map<number, number>()
  private pending: string[] = []
  private motion: [number, number] = [0, 0]
  private touch: [number, number] | null = null
  private wheel = 0
  dragging = false
  private padUnits = new Map<number, number>()
  constructor(readonly count: () => number, readonly tray: readonly TrayControl[] = []) {}
  clear() { this.keys.clear(); this.before.clear(); this.pending = []; this.motion = [0, 0]; this.touch = null; this.wheel = 0; this.dragging = false }
  disarm() { this.armed = false; this.clear() }
  press(id: string) { if (this.armed) this.pending.push(id) }
  key(code: string, down: boolean) {
    if (down) {
      if (this.keys.has(code)) return
      this.keys.add(code)
      const n = /^Digit([1-9])$/.exec(code)
      if (n && this.tray[Number(n[1]) - 1]?.type === 'button') this.press(this.tray[Number(n[1]) - 1].id)
    } else this.keys.delete(code)
  }
  move(x: number, y: number) { this.motion[0] += Number.isFinite(x) ? clamp(x, -90, 90) : 0; this.motion[1] += Number.isFinite(y) ? clamp(y, -90, 90) : 0 }
  scroll(delta: number) { this.wheel += Number.isFinite(delta) ? clamp(delta, -2400, 2400) : 0 }
  touchStick(x: number, y: number) { this.touch = stick(x, y, 0) }
  releaseTouch() { this.touch = null }
  assign(index: number, unit: number) { this.padUnits.set(index, clamp(unit, 0, this.count() - 1)); this.before.delete(index) }
  selectUnit(unit: number) { this.disarm(); this.unit = clamp(unit, 0, this.count() - 1); this.padUnits.clear() }
  /** Every read consumes deltas once; pads keep stable seats across hot-plug and sparse API indices. */
  read(pads: readonly (PadLike | null)[], visible = true): Map<number, DeviceInput> {
    const frames = new Map<number, DeviceInput>()
    const connected = pads.filter((p): p is PadLike => !!p && !!standardPad(p))
    for (const index of this.before.keys()) if (!connected.some(p => p.index === index)) this.before.delete(index)
    if (!visible || !this.armed) { this.clear(); return frames }
    if (this.source === 'gamepad') {
      const occupied = new Set<number>()
      const reserved = new Set(connected.map(p => this.padUnits.get(p.index)).filter((n): n is number => n !== undefined && n < this.count()))
      for (const p of connected) {
        let unit = this.padUnits.get(p.index)
        if (unit === undefined || unit >= this.count()) {
          unit = connected[0] === p && !reserved.has(this.unit) ? this.unit : Array.from({ length: this.count() }, (_, n) => n).find(n => !occupied.has(n) && !reserved.has(n))
          if (unit === undefined) continue
          this.padUnits.set(p.index, unit)
          reserved.add(unit)
        }
        if (occupied.has(unit)) continue
        occupied.add(unit)
        const pad = standardPad(p)!, input = restInput()
        input.pad = pad; input.padPressed = pad.buttons & ~(this.before.get(p.index) ?? 0)
        this.before.set(p.index, pad.buttons)
        input.presses = connected[0] === p ? this.pending : []
        frames.set(unit, input)
      }
    } else if (this.source === 'keyboard') {
      const held = (id: string) => Number(this.bindings[id]?.some(k => this.keys.has(k)))
      const pad = emptyPad()
      pad.axes = [held('right') - held('left'), held('back') - held('forward'), clamp(held('turnRight') - held('turnLeft') + held('lookRight') - held('lookLeft'), -1, 1), held('lookDown') - held('lookUp')]
      if (this.touch) { pad.axes[0] = this.touch[0]; pad.axes[1] = this.touch[1] }
      // A drag can steer a vehicle as well as aim. Held movement keys retain the primary stick.
      if (!pad.axes[0] && !pad.axes[1] && !this.touch) { pad.axes[0] = clamp(this.motion[0] / 45, -1, 1); pad.axes[1] = clamp(this.motion[1] / 45, -1, 1) }
      pad.axes[2] = clamp(pad.axes[2] + this.motion[0] / 45, -1, 1)
      pad.axes[3] = clamp(pad.axes[3] + this.motion[1] / 45, -1, 1)
      pad.triggers = [Math.max(held('lower'), clamp(this.wheel / 120, 0, 1)), Math.max(held('rise'), clamp(-this.wheel / 120, 0, 1))]
      for (const [n, id] of ['primary', 'secondary', 'third', 'fourth'].entries()) if (held(id)) pad.buttons |= 1 << n
      if (held('home')) pad.buttons |= 1 << PadButton.Guide
      const input = restInput()
      input.pad = pad; input.padPressed = pad.buttons & ~(this.before.get(-1) ?? 0)
      this.before.set(-1, pad.buttons)
      input.wheel = this.wheel; input.pinch = -this.wheel / 1200
      input.presses = this.pending
      frames.set(this.unit, input)
    }
    this.motion = [0, 0]; this.wheel = 0; this.pending = []
    return frames
  }
}
