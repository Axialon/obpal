import '../styles/gamepad.css'
import { emptyPad, encodePad, PAD_BYTES, PadButton, PadFlag } from '@obpal/core'
import { hapticsKind, tick } from './haptics'
import { GyroSmoother, playerSpaceRates, TiltStick } from './gyro'
import type { Motion } from './motion'
import { ICONS } from '../ui/icons'

type Vec2 = [number, number]

// ---- tuning -------------------------------------------------------------------

/** Touch sticks: radial deadzone and outer clamp (fractions of full travel), and the response curve (> 1 = finer near the centre). */
export const STICK = { dead: 0.12, outer: 0.08, curve: 1.35 }
/** Gyro aim: turning the phone this fast (degrees/second) is a full right-stick deflection at 1x sensitivity. */
export const GYRO_FULL_DPS = 180
/**
 * Analog triggers read press depth. A touch alone is a light pull (above the Gamepad API's pressed threshold of about 0.12);
 * sliding down through `travel` of the trigger's height pulls it all the way (1).
 */
export const TRIGGER = { floor: 0.3, travel: 0.85 }
/** Rumble at or below this magnitude counts as off. */
export const RUMBLE_MIN = 0.1

const TAP_MS = 280 // a stick released this soon...
const TAP_SLOP = 10 // ...having moved less than this (px) is a stick click (L3/R3)
const CLICK_MS = 120 // a stick click stays in the bitmask this long, so one lost packet can't swallow it
const IDLE_MS = 66 // 15 Hz while nothing is held
const MIN_GAP_MS = 12 // stay near 60 Hz whatever rate the motion sensor fires at
const HANDOFF_MS = 250 // see GamepadMode.pump()
const MAX_RUMBLE_MS = 5000 // the Gamepad API's playEffect limit

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const bit = (b: number) => 1 << b

// ---- pure helpers (unit tested) -------------------------------------------------

/**
 * Shape a raw stick vector (1 = full travel): radial deadzone, outer clamp to exactly 1, then the response curve.
 * The direction is kept, so diagonals stay diagonal.
 */
export function shapeStick(x: number, y: number, dead = STICK.dead, outer = STICK.outer, curve = STICK.curve): Vec2 {
  const m = Math.hypot(x, y)
  if (m <= dead) return [0, 0]
  const t = Math.min(1, (m - dead) / Math.max(1e-6, 1 - dead - outer))
  const k = Math.pow(t, curve)
  return [(x / m) * k, (y / m) * k]
}

/**
 * Gyro aim: player-space turn rates in degrees/second (yaw + = turning left, pitch + = tipping the top up)
 * as a right-stick deflection (+x right, +y down, as in the Gamepad API), about ±1 at 180°/s times the sensitivity.
 */
export function gyroToStick(yawDps: number, pitchDps: number, gain = 1): Vec2 {
  const k = gain / GYRO_FULL_DPS
  return [clamp(-yawDps * k, -1, 1), clamp(-pitchDps * k, -1, 1)]
}

/** Sum of two stick vectors, clamped to the unit circle (a thumb plus gyro can't exceed a full deflection). */
export function addStick(a: Vec2, b: Vec2): Vec2 {
  const x = a[0] + b[0]
  const y = a[1] + b[1]
  const m = Math.hypot(x, y)
  return m > 1 ? [x / m, y / m] : [x, y]
}

/** Trigger value from the finger's height inside the trigger (client px): the top is a light touch, sliding down pulls harder. */
export function triggerDepth(y: number, top: number, height: number, floor = TRIGGER.floor, travel = TRIGGER.travel): number {
  const t = height > 0 ? clamp((y - top) / (height * travel), 0, 1) : 1
  return 1 - (1 - floor) * (1 - t) // exactly 1 at full travel
}

/**
 * D-pad bits from a touch offset (px) to the pad's centre: each direction owns ±60° around its axis,
 * which leaves 60° cardinal sectors and 30° diagonals (two bits). Nothing inside the `dead` radius.
 */
export function dpadBits(dx: number, dy: number, dead: number): number {
  if (Math.hypot(dx, dy) < dead) return 0
  const a = (Math.atan2(dy, dx) * 180) / Math.PI // 0 = right, 90 = down (screen y grows downward)
  const near = (axis: number) => Math.abs(((((a - axis) % 360) + 540) % 360) - 180) < 60
  return (near(0) ? bit(PadButton.Right) : 0) | (near(90) ? bit(PadButton.Down) : 0) | (near(180) ? bit(PadButton.Left) : 0) | (near(-90) ? bit(PadButton.Up) : 0)
}

/**
 * navigator.vibrate() argument for a dual-rumble request. The strong motor is a continuous buzz; the weak motor alone
 * is short pulses, which reads as lighter. Long patterns stretch their period so they stay within Chrome's ~100-entry cap.
 */
export function rumblePattern(strong: number, weak: number, ms: number): number | number[] {
  if (Math.max(strong, weak) <= RUMBLE_MIN || ms <= 0) return 0
  const d = Math.round(Math.min(ms, MAX_RUMBLE_MS))
  if (strong > RUMBLE_MIN) return d
  const on0 = 6 + 10 * weak
  const period = Math.max(on0 + 18, d / 48)
  const on = Math.max(1, Math.round((period * on0) / (on0 + 18)))
  const off = Math.max(1, Math.round(period - on))
  const out: number[] = []
  for (let t = 0; t < d; t += on + off) out.push(Math.min(on, d - t), off)
  out.pop() // no trailing pause
  return out
}

// ---- layer markup -----------------------------------------------------------------

function layerHtml(): string {
  const B = PadButton
  const trig = (i: 0 | 1) => `<button class="gp-trig" data-trig="${i}" aria-label="${i ? 'Right' : 'Left'} trigger"><i class="gp-fill"></i><b>${i ? 'RT' : 'LT'}</b></button>`
  const bump = (b: number, side: string) => `<button class="gp-bump" data-b="${b}" aria-label="${side} bumper"><b>${side[0]}B</b></button>`
  const round = (cls: string, b: number, label: string, ic: string) => `<button class="${cls}" data-b="${b}" aria-label="${label}">${ic}</button>`
  const face = (k: string, b: number) => `<button class="gp-f" data-k="${k}" data-b="${b}" aria-label="${k.toUpperCase()}">${k.toUpperCase()}</button>`
  const arm = (dir: string, b: number) => `<i data-dir="${dir}" data-bit="${b}">${ICONS.chevron}</i>`
  const stick = (i: 0 | 1) => `<div class="gp-stick" data-stick="${i}" role="group" aria-label="${i ? 'Right' : 'Left'} stick, tap to click"><i class="gp-base"><i class="gp-knob"></i></i></div>`
  return `
    <div class="gp" hidden role="application" aria-label="Gamepad">
      <div class="gp-sh l">${trig(0)}${bump(B.LB, 'Left')}</div>
      <div class="gp-top">
        <button class="gp-mini" data-act="exit" aria-label="Leave gamepad">${ICONS.left}</button>
        ${round('gp-guide', B.Guide, 'Guide', ICONS.guide)}
        <button class="gp-mini" data-act="settings" aria-label="Settings">${ICONS.settings}</button>
      </div>
      <div class="gp-sh r">${bump(B.RB, 'Right')}${trig(1)}</div>
      <div class="gp-cue" role="img" aria-label="Turn your phone sideways for the full controller">${ICONS.phone}</div>
      <div class="gp-side l">
        ${stick(0)}
        <div class="gp-dpad" role="group" aria-label="D-pad">${arm('up', B.Up)}${arm('right', B.Right)}${arm('down', B.Down)}${arm('left', B.Left)}</div>
      </div>
      <div class="gp-mid">
        <div class="gp-center">${round('gp-sm', B.View, 'View', ICONS.view)}${round('gp-sm', B.Menu, 'Menu', ICONS.menu)}</div>
        <div class="gp-chips">
          <button class="gp-chip" data-chip="aim" aria-pressed="false" aria-label="Gyro aim (right stick)">${ICONS.gyro}<span>Aim</span></button>
          <button class="gp-chip" data-chip="steer" aria-pressed="false" aria-label="Tilt steering (left stick)">${ICONS.tilt}<span>Steer</span></button>
        </div>
      </div>
      <div class="gp-side r">
        ${stick(1)}
        <div class="gp-face">${face('y', B.Y)}${face('x', B.X)}${face('b', B.B)}${face('a', B.A)}</div>
      </div>
    </div>`
}

type Handler = (e: PointerEvent) => void
function listen(el: HTMLElement, down: Handler, move: Handler | null, up: Handler) {
  el.addEventListener('pointerdown', down)
  if (move) el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener('lostpointercapture', up)
}
function capture(el: HTMLElement, e: PointerEvent) {
  e.preventDefault()
  try { el.setPointerCapture(e.pointerId) } catch { /* synthetic events */ }
}

// ---- floating thumbstick ---------------------------------------------------------------

/** The base appears where the thumb lands (kept inside the zone); a tap without dragging is a stick click. */
class Stick {
  value: Vec2 = [0, 0]
  private base: HTMLElement
  private knob: HTMLElement
  private id: number | null = null
  private box = { left: 0, top: 0 }
  private c: Vec2 = [0, 0] // base centre, zone px
  private start: Vec2 = [0, 0]
  private at = 0
  private moved = false
  private travel = 0
  private driven = false

  constructor(private zone: HTMLElement, private onClick: () => void) {
    this.base = zone.querySelector<HTMLElement>('.gp-base')!
    this.knob = zone.querySelector<HTMLElement>('.gp-knob')!
    listen(zone, this.down, this.move, this.up)
  }

  get touching() { return this.id !== null }

  private measure() {
    const r = this.base.offsetWidth / 2 || 56
    this.travel = Math.max(20, r - 8)
    return r
  }

  private down = (e: PointerEvent) => {
    if (this.id !== null) return
    capture(this.zone, e)
    this.id = e.pointerId
    const R = this.measure()
    const r = this.zone.getBoundingClientRect()
    this.box = { left: r.left, top: r.top }
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    this.c = [r.width > 2 * R ? clamp(x, R, r.width - R) : r.width / 2, r.height > 2 * R ? clamp(y, R, r.height - R) : r.height / 2]
    this.start = [e.clientX, e.clientY]
    this.at = performance.now()
    this.moved = false
    this.base.style.left = `${this.c[0]}px`
    this.base.style.top = `${this.c[1]}px`
    this.zone.classList.add('on')
    this.track(e)
  }

  private move = (e: PointerEvent) => { if (e.pointerId === this.id) this.track(e) }

  private track(e: PointerEvent) {
    const dx = e.clientX - this.box.left - this.c[0]
    const dy = e.clientY - this.box.top - this.c[1]
    if (!this.moved && Math.hypot(e.clientX - this.start[0], e.clientY - this.start[1]) > TAP_SLOP) this.moved = true
    this.value = shapeStick(dx / this.travel, dy / this.travel)
    if (this.driven) return // the pump draws thumb + motion together
    const m = Math.hypot(dx, dy)
    const k = m > this.travel ? this.travel / m : 1
    this.knob.style.transform = `translate3d(${dx * k}px, ${dy * k}px, 0)`
  }

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.id) return
    const click = e.type === 'pointerup' && !this.moved && performance.now() - this.at < TAP_MS
    this.reset()
    if (click) {
      this.zone.classList.add('click')
      setTimeout(() => this.zone.classList.remove('click'), 160)
      this.onClick()
    }
  }

  /** Keep tracking after the layout moved under the thumb (entering fullscreen). */
  remeasure() {
    if (this.id === null) return
    const r = this.zone.getBoundingClientRect()
    this.box = { left: r.left, top: r.top }
  }

  reset() {
    this.id = null
    this.value = [0, 0]
    this.zone.classList.remove('on')
    this.base.style.left = ''
    this.base.style.top = ''
    if (!this.driven) this.knob.style.transform = ''
  }

  /** Draw a deflection that isn't only the thumb's (gyro aim, tilt steering); null hands the knob back to the thumb. */
  show(v: Vec2 | null) {
    if (!v) {
      if (!this.driven) return
      this.driven = false
      this.zone.classList.remove('live')
      if (this.id === null) this.knob.style.transform = ''
      return
    }
    if (!this.travel) this.measure()
    this.driven = true
    this.zone.classList.add('live')
    this.knob.style.transform = `translate3d(${v[0] * this.travel}px, ${v[1] * this.travel}px, 0)`
  }
}

// ---- gamepad mode ----------------------------------------------------------------------

export interface GamepadDeps {
  motion: Motion
  /** Live settings: gain scales gyro aim and tilt steering, smooth sets gyro steadiness. */
  settings: { gain: number; smooth: number }
  /** Session clock origin (performance.now() at boot), shared with STATE so capture times line up. */
  t0: number
  /** Send one packet on the unreliable channel; false when it was dropped. */
  send: (packet: ArrayBuffer) => boolean
  toast: (text: string) => void
  openSettings: () => void
  /** Leave gamepad mode (back to another tab). */
  exit: () => void
  /** Enter fullscreen where the platform allows it; called from a pointerup. */
  fullscreen?: () => void
}

/**
 * Gamepad mode: a full-screen Xbox-style controller (floating sticks with click, D-pad, ABXY, bumpers, analog triggers,
 * View / Menu / Guide) with optional gyro aim on the right stick and tilt steering on the left stick's X axis.
 * Streams PAD packets (packages/core/src/pad.ts) in place of STATE while it is active.
 */
export class GamepadMode {
  private el: HTMLElement | null = null
  private active = false
  private readonly pad = emptyPad()
  private readonly buf = new ArrayBuffer(PAD_BYTES)
  /** Button bits per pointer; each pointer is captured by exactly one control. */
  private readonly held = new Map<number, number>()
  private clicks: { bit: number; until: number }[] = []
  private sticks: Stick[] = []
  private readonly trig: Vec2 = [0, 0]
  private resets: (() => void)[] = []
  private remeasures: (() => void)[] = []
  private aim = false
  private steer = false
  private gyro: Vec2 = [0, 0]
  private steerX = 0
  private readonly smoother = new GyroSmoother()
  private readonly tilt = new TiltStick()
  private lastSend = 0
  private handoffUntil = 0
  private rumbleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: GamepadDeps) {
    document.addEventListener('visibilitychange', () => {
      if (!this.active) return
      if (document.visibilityState === 'hidden') { this.releaseAll(); this.sendNeutral() }
      else this.relevel()
    })
    addEventListener('resize', () => { for (const f of this.remeasures) f() })
  }

  /** Build the layer inside the control surface. Call again whenever the surface is rebuilt. */
  mount(surface: HTMLElement) {
    this.releaseAll()
    this.resets = []
    this.remeasures = []
    surface.insertAdjacentHTML('beforeend', layerHtml())
    const el = surface.querySelector<HTMLElement>('.gp')!
    this.el = el
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false })
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    el.addEventListener('pointerup', () => this.deps.fullscreen?.())
    el.querySelectorAll<HTMLElement>('[data-b]').forEach((b) => this.bindButton(b, Number(b.dataset.b)))
    el.querySelectorAll<HTMLElement>('[data-trig]').forEach((t) => this.bindTrigger(t, t.dataset.trig === '1' ? 1 : 0))
    this.bindDpad(el.querySelector<HTMLElement>('.gp-dpad')!)
    this.sticks = [...el.querySelectorAll<HTMLElement>('.gp-stick')].map((z, i) => new Stick(z, () => this.click(i ? PadButton.R3 : PadButton.L3)))
    for (const s of this.sticks) { this.resets.push(() => s.reset()); this.remeasures.push(() => s.remeasure()) }
    el.querySelectorAll<HTMLElement>('[data-chip]').forEach((c) => { c.onclick = () => { tick(); this.toggle(c.dataset.chip === 'aim' ? 'aim' : 'steer') } })
    el.querySelector<HTMLElement>('[data-act="exit"]')!.onclick = () => { tick(); this.deps.exit() }
    el.querySelector<HTMLElement>('[data-act="settings"]')!.onclick = () => { tick(); this.deps.openSettings() }
    this.paintChips()
    el.hidden = !this.active
    surface.classList.toggle('gp-on', this.active)
    document.documentElement.classList.toggle('gp-mode', this.active)
  }

  /** Called on every surface render: offer the Gamepad tab only when the host lists the mode, and show or hide the layer. */
  sync(o: { active: boolean; offered: boolean }) {
    const tab = this.el?.parentElement?.querySelector<HTMLElement>('[data-tab="gamepad"]')
    if (tab) tab.hidden = !o.offered
    this.el?.classList.toggle('no-motion', !this.deps.motion.q)
    this.setActive(o.active)
  }

  /**
   * One tick of the state pump (each motion sample, or every 16 ms without motion). Sends a PAD packet: about 60 Hz while
   * anything is held or motion is steering, 15 Hz at rest. Returns true when the tick is fully handled and no STATE should
   * be sent. Right after entering gamepad mode it returns false for a moment, so the caller's STATE packets (which now
   * carry mode = gamepad) tell the host to stop applying the previous mode's gyro or tilt; after that only PAD is sent.
   */
  pump(): boolean {
    if (!this.active) return false
    const now = performance.now()
    this.sampleMotion()
    this.compose(now)
    const [lx, ly, rx, ry] = this.pad.axes
    this.sticks[0]?.show(this.steer ? [lx, ly] : null)
    this.sticks[1]?.show(this.aim ? [rx, ry] : null)
    const gap = now - this.lastSend
    if (gap >= MIN_GAP_MS && (gap >= IDLE_MS || this.busy(now))) this.sendPad(now)
    return now >= this.handoffUntil
  }

  /** Host rumble (dual-rumble semantics). Android vibrates; iOS web pages can't vibrate outside a tap, so the layer's border pulses. */
  rumble(strong: number, weak: number, ms: number) {
    const s = clamp(Number(strong) || 0, 0, 1)
    const w = clamp(Number(weak) || 0, 0, 1)
    const d = clamp(Number(ms) || 0, 0, MAX_RUMBLE_MS)
    if (hapticsKind() === 'vibrate') { navigator.vibrate(rumblePattern(s, w, d)); return }
    this.pulse(Math.max(s, w), d)
  }

  // ---- internals --------------------------------------------------------------------

  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    const el = this.el
    if (el) { el.hidden = !on; el.parentElement?.classList.toggle('gp-on', on) }
    document.documentElement.classList.toggle('gp-mode', on)
    if (on) {
      this.handoffUntil = performance.now() + HANDOFF_MS
      this.lastSend = 0
      this.relevel()
    } else {
      this.releaseAll()
      this.pulse(0, 0)
      // Leave the host a neutral pad, so nothing keeps moving until its pad times out.
      this.sendNeutral()
      for (const ms of [40, 100]) setTimeout(() => { if (!this.active) this.sendNeutral() }, ms)
    }
  }

  private relevel() {
    const { motion } = this.deps
    this.smoother.reset()
    if (this.steer && motion.q) this.tilt.capture(motion.up())
  }

  private toggle(which: 'aim' | 'steer') {
    const { motion } = this.deps
    if (which === 'aim') {
      if (!this.aim && !motion.hasGyro) return this.deps.toast('Motion is off on this phone')
      this.aim = !this.aim
      this.smoother.reset()
    } else {
      if (!this.steer && !motion.q) return this.deps.toast('Motion is off on this phone')
      this.steer = !this.steer
      if (this.steer) this.tilt.capture(motion.up()) // the pose right now is straight ahead
    }
    this.paintChips()
    this.changed()
  }

  private paintChips() {
    this.el?.querySelectorAll<HTMLElement>('[data-chip]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.chip === 'aim' ? this.aim : this.steer)))
  }

  private sampleMotion() {
    const { motion, settings } = this.deps
    this.smoother.smoothBelow = 4 + 8 * settings.smooth
    this.gyro = [0, 0]
    if (this.aim && motion.hasGyro && motion.flowing) {
      const [yaw, pitch] = this.smoother.apply(...playerSpaceRates(motion.gyro, motion.up()))
      this.gyro = gyroToStick(yaw, pitch, settings.gain)
    }
    this.steerX = this.steer && motion.q ? this.tilt.stick(motion.up(), settings.gain)[0] : 0
  }

  private compose(now: number) {
    const p = this.pad
    const l = this.sticks[0]?.value ?? [0, 0]
    const r = this.sticks[1]?.value ?? [0, 0]
    const L = this.steerX ? addStick(l, [this.steerX, 0]) : l
    const R = this.gyro[0] || this.gyro[1] ? addStick(r, this.gyro) : r
    p.axes = [L[0], L[1], R[0], R[1]]
    p.triggers = [this.trig[0], this.trig[1]]
    let m = 0
    for (const b of this.held.values()) m |= b
    this.clicks = this.clicks.filter((c) => c.until > now)
    for (const c of this.clicks) m |= bit(c.bit)
    p.buttons = m >>> 0
    p.flags = (this.aim ? PadFlag.gyroAim : 0) | (this.steer ? PadFlag.tiltSteer : 0)
  }

  private busy(now: number) {
    return this.aim || this.steer || this.held.size > 0 || this.trig[0] > 0 || this.trig[1] > 0 ||
      this.sticks.some((s) => s.touching) || this.clicks.some((c) => c.until > now)
  }

  /** Same conventions as STATE: u16 seq per packet, capture time in µs on the session clock. */
  private sendPad(now: number) {
    const p = this.pad
    p.seq = (p.seq + 1) & 0xffff
    p.t = Math.round((now - this.deps.t0) * 1000) >>> 0
    if (this.deps.send(encodePad(p, this.buf))) this.lastSend = now
  }

  private sendNeutral() {
    const p = this.pad
    p.buttons = 0
    p.axes = [0, 0, 0, 0]
    p.triggers = [0, 0]
    p.flags = 0
    this.sendPad(performance.now())
  }

  /** A button edge: send now rather than on the next tick. */
  private changed() {
    if (!this.active) return
    const now = performance.now()
    this.compose(now)
    this.sendPad(now)
  }

  private click(b: number) {
    tick()
    this.clicks.push({ bit: b, until: performance.now() + CLICK_MS })
    this.changed()
  }

  private releaseAll() {
    for (const r of this.resets) r()
    this.held.clear()
    this.clicks = []
    this.trig[0] = this.trig[1] = 0
  }

  private bindButton(el: HTMLElement, b: number) {
    const ids = new Set<number>()
    const down = (e: PointerEvent) => {
      capture(el, e)
      ids.add(e.pointerId)
      this.held.set(e.pointerId, bit(b))
      el.classList.add('on')
      tick()
      this.changed()
    }
    const up = (e: PointerEvent) => {
      if (!ids.delete(e.pointerId)) return
      this.held.delete(e.pointerId)
      if (!ids.size) el.classList.remove('on')
      this.changed()
    }
    listen(el, down, null, up)
    this.resets.push(() => { ids.clear(); el.classList.remove('on') })
  }

  private bindDpad(el: HTMLElement) {
    const arms = [...el.querySelectorAll<HTMLElement>('[data-dir]')]
    const ids = new Map<number, number>()
    let c: Vec2 = [0, 0]
    let dead = 0
    const measure = () => {
      const r = el.getBoundingClientRect()
      c = [r.left + r.width / 2, r.top + r.height / 2]
      dead = r.width * 0.12
    }
    const paint = () => {
      let m = 0
      for (const bits of ids.values()) m |= bits
      for (const a of arms) a.classList.toggle('on', (m & bit(Number(a.dataset.bit))) !== 0)
    }
    const aim = (e: PointerEvent) => {
      const bits = dpadBits(e.clientX - c[0], e.clientY - c[1], dead)
      const prev = ids.get(e.pointerId) ?? 0
      if (bits === prev) return
      ids.set(e.pointerId, bits)
      this.held.set(e.pointerId, bits)
      if (bits & ~prev) tick() // every newly pressed direction
      paint()
      this.changed()
    }
    const down = (e: PointerEvent) => {
      capture(el, e)
      measure()
      ids.set(e.pointerId, 0)
      this.held.set(e.pointerId, 0)
      aim(e)
    }
    const move = (e: PointerEvent) => { if (ids.has(e.pointerId)) aim(e) }
    const up = (e: PointerEvent) => {
      if (!ids.delete(e.pointerId)) return
      this.held.delete(e.pointerId)
      paint()
      this.changed()
    }
    listen(el, down, move, up)
    this.resets.push(() => { ids.clear(); paint() })
    this.remeasures.push(() => { if (ids.size) measure() })
  }

  private bindTrigger(el: HTMLElement, i: 0 | 1) {
    const fill = el.querySelector<HTMLElement>('.gp-fill')!
    let id: number | null = null
    let top = 0
    let height = 1
    const set = (v: number) => {
      if (v >= 1 && this.trig[i] < 1) tick(true) // bottomed out
      this.trig[i] = v
      fill.style.transform = `scaleY(${v})`
    }
    const measure = () => { const r = el.getBoundingClientRect(); top = r.top; height = r.height }
    const release = () => { id = null; this.trig[i] = 0; el.classList.remove('on'); fill.style.transform = '' }
    const down = (e: PointerEvent) => {
      if (id !== null) return
      capture(el, e)
      id = e.pointerId
      measure()
      el.classList.add('on')
      tick()
      this.trig[i] = triggerDepth(e.clientY, top, height)
      fill.style.transform = `scaleY(${this.trig[i]})`
      this.changed()
    }
    const move = (e: PointerEvent) => { if (e.pointerId === id) set(triggerDepth(e.clientY, top, height)) }
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return
      release()
      this.changed()
    }
    listen(el, down, move, up)
    this.resets.push(release)
    this.remeasures.push(() => { if (id !== null) measure() })
  }

  private pulse(mag: number, ms: number) {
    const el = this.el
    clearTimeout(this.rumbleTimer)
    if (!el) return
    if (!this.active || mag <= RUMBLE_MIN || ms <= 0) { el.classList.remove('rumble'); return }
    el.style.setProperty('--gp-rumble', mag.toFixed(2))
    el.classList.add('rumble')
    this.rumbleTimer = setTimeout(() => el.classList.remove('rumble'), clamp(ms, 90, 700))
  }
}
