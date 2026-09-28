import { type Content, html, insertMarkup, setMarkup } from '../ui/markup'
import '../styles/gamepad.css'
import {
  addStick as mixAdd, emptyPad, emptyPointer, encodePad, encodePointer, flyVector, isProfileId, mixStick, MOTION_UTILITIES, offeredMotion,
  PAD_BYTES, PadButton, PadFlag, POINTER_BYTES, PointerFlag, PROFILE_IDS, PROFILES, rateToUnit, resolveProfile, ROUTES, shapeVector, Utility,
  utilityKey, wheelVector,
  type Contribution, type MotionUtility, type Profile, type ProfileId, type ProfileOverrides, type Route, type UtilitySettings,
} from '@obpal/core'
import { toUi, uiRect } from './uiframe'
import { sheetExits } from './sheet'
import { feedbackEnabled, gamepadFeedback, hapticsKind, tick } from './haptics'
import { GyroSmoother, playerSpaceRates, TiltStick } from './gyro'
import { screenAngle, type Motion } from './motion'
import { WiiPointer } from './pointing'
import { ICONS } from '../ui/icons'
import type { FamilyApi } from '../family'
import { reachOf, type Reach } from '../control-space'

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
const LONG_PRESS_MS = 460 // holding a motion chip opens its options

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const bit = (b: number) => 1 << b
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* private mode */ } },
}

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
export const addStick = (a: Vec2, b: Vec2): Vec2 => mixAdd(a, b)

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

/** What the motion utilities feed the sticks with, this tick. Null while a utility is off or its sensor is missing. */
export interface MotionInputs {
  /** Aim: player-space turn rates, degrees/second (yaw + = turning left, pitch + = tipping up). */
  rates: readonly [number, number] | null
  /** Steer: the tilt stick [steer + = right, pitch + = top edge toward the user] in −1…1. */
  tilt: readonly [number, number] | null
}

export interface Composed {
  /** [LX, LY, RX, RY] as the Gamepad API reads them (+Y down). */
  axes: [number, number, number, number]
  /** Aim routed to the mouse: turn rates to integrate, degrees/second, + = right and + = up. Null otherwise. */
  mouse: [number, number] | null
}

/**
 * The catalogue's routes and response (CATALOGUE §2) from the thumbs and the motion utilities to the four axes.
 * Each utility is shaped by its own gain, curve and invert, then mixed into the stick its route names; a stick with
 * motion on it gets one deadzone jump so small deliberate motions land past the game's deadzone.
 */
export function composeSticks(left: Vec2, right: Vec2, m: MotionInputs, profile: Profile, gain = 1): Composed {
  const L: Contribution[] = []
  const R: Contribution[] = []
  let mouse: [number, number] | null = null
  const shape = (v: Vec2, s: UtilitySettings): Vec2 => shapeVector(v, { gain: s.gain * gain, curve: s.curve, invertY: s.invertY })
  if (m.rates) {
    const s = profile.aim
    if (s.route === 'mouse') mouse = [-m.rates[0] * s.gain * gain, m.rates[1] * s.gain * gain * (s.invertY ? -1 : 1)]
    else (s.route === 'stick.left' ? L : R).push({ v: shape(rateToUnit(m.rates[0], m.rates[1]), s), deadzone: s.deadzone })
  }
  if (m.tilt) {
    const s = profile.steer
    const base = s.route === 'stick.wheel' ? wheelVector(m.tilt) : flyVector(m.tilt)
    const target = s.route === 'stick.wheel' || s.route === 'stick.left' ? L : R
    target.push({ v: shape(base, s), deadzone: s.deadzone })
  }
  const l = mixStick(left, L)
  const r = mixStick(right, R)
  return { axes: [l[0], l[1], r[0], r[1]], mouse }
}

/** Where a remembered profile choice lives: per host, and per suggestion the host makes (a suggestion is per site). */
export const profileKey = (host: string, suggested: string | null) => `obpal.profile.${host}|${suggested ?? ''}`

/** The profile in effect: the user's choice for this host and suggestion, else the host's suggestion, else default. */
export function activeProfile(chosen: string | null, suggested: string | null | undefined): ProfileId {
  if (isProfileId(chosen)) return chosen
  if (isProfileId(suggested)) return suggested
  return 'default'
}

// ---- layer markup -----------------------------------------------------------------

const ROUTE_META: Record<Route, { label: string; icon: string }> = {
  'stick.right': { label: 'R stick', icon: 'stickR' },
  'stick.left': { label: 'L stick', icon: 'stickL' },
  'stick.fly': { label: 'Fly', icon: 'fly' },
  'stick.wheel': { label: 'Wheel', icon: 'wheel' },
  mouse: { label: 'Mouse', icon: 'mouse' },
  pointer: { label: 'Cursor', icon: 'cursor' },
}
const PROFILE_ICON: Record<ProfileId, string> = { default: 'gamepad', flight: 'plane', driving: 'wheel', shooter: 'point', pointer: 'cursor' }
const UTILITY_META: Record<MotionUtility, { label: string; title: string }> = {
  'motion.aim': { label: 'Aim', title: 'Gyro aim: turning the phone turns the view' },
  'motion.steer': { label: 'Steer', title: 'Tilt steering: hold the phone tilted' },
  'motion.point': { label: 'Point', title: 'Wii-style pointer: the cursor is where the phone points' },
}

function layerHtml(): Content {
  const B = PadButton
  const trig = (i: 0 | 1) => html`<button class="gp-trig" data-trig="${i}" aria-label="${i ? 'Right' : 'Left'} trigger"><i class="gp-fill"></i><b>${i ? 'RT' : 'LT'}</b></button>`
  const bump = (b: number, side: string) => html`<button class="gp-bump" data-b="${b}" aria-label="${side} bumper"><b>${side[0]}B</b></button>`
  const round = (cls: string, b: number, label: string, ic: Content) => html`<button class="${cls}" data-b="${b}" aria-label="${label}">${ic}</button>`
  const face = (k: string, b: number) => html`<button class="gp-f" data-k="${k}" data-b="${b}" aria-label="${k.toUpperCase()}">${k.toUpperCase()}</button>`
  const arm = (dir: string, b: number) => html`<i data-dir="${dir}" data-bit="${b}">${ICONS.chevron}</i>`
  const stick = (i: 0 | 1) => html`<div class="gp-stick" data-stick="${i}" role="group" aria-label="${i ? 'Right' : 'Left'} stick, tap to click"><i class="gp-base"><i class="gp-knob"></i></i></div>`
  return html`
    <div class="gp" hidden role="application" aria-label="Gamepad">
      <div class="gp-sh l">${trig(0)}${bump(B.LB, 'Left')}</div>
      <div class="gp-top">
        <div class="gp-sys l"><button class="gp-mini" data-act="exit" aria-label="Back">${ICONS.left}</button><button class="gp-mini" data-act="controllers" aria-haspopup="dialog" aria-label="All controllers">${ICONS.models}</button></div>
        ${round('gp-guide', B.Guide, 'Guide', ICONS.guide)}
        <div class="gp-sys r"><button class="gp-mini" data-act="settings" aria-label="Settings">${ICONS.settings}</button></div>
      </div>
      <div class="gp-sh r">${bump(B.RB, 'Right')}${trig(1)}</div>
      <div class="gp-cue" role="img" aria-label="Turn your phone sideways for the full controller">${ICONS.phone}</div>
      <div class="gp-side l">
        ${stick(0)}
        <div class="gp-dpad" role="group" aria-label="D-pad">${arm('up', B.Up)}${arm('right', B.Right)}${arm('down', B.Down)}${arm('left', B.Left)}</div>
      </div>
      <div class="gp-mid">
        <div class="gp-center">${round('gp-sm', B.View, 'View', ICONS.view)}<div class="gp-wheel" aria-hidden="true"><i>${ICONS.wheel}</i></div>${round('gp-sm', B.Menu, 'Menu', ICONS.menu)}</div>
        <button class="gp-scope" data-act="scope" type="button" aria-label="Scene scope" hidden><i class="gp-scope-ic">${ICONS.cube}</i><span>Object</span><small hidden></small></button>
        <div class="gp-motion" role="group" aria-label="Motion">
          <div class="gp-chips"></div>
          <div class="gp-tools">
            <button class="gp-chip gp-prof" data-act="profile" aria-haspopup="dialog" aria-label="Profile"></button>
            <button class="gp-chip gp-centre" data-act="centre" aria-label="Centre here" hidden>${ICONS.center}</button>
          </div>
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
/** A sheet opened under a held finger: the finger lifting off lands a click on whatever is now beneath it. Drop that one click. */
function swallowNextClick() {
  const stop = (e: Event) => { e.stopPropagation(); e.preventDefault(); off() }
  const off = () => { document.removeEventListener('click', stop, true); clearTimeout(t) }
  const t = setTimeout(off, 1200)
  document.addEventListener('click', stop, true)
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
    const r = uiRect(this.zone)
    const at = toUi(e.clientX, e.clientY)
    this.box = { left: r.left, top: r.top }
    const x = at.x - r.left
    const y = at.y - r.top
    this.c = [r.width > 2 * R ? clamp(x, R, r.width - R) : r.width / 2, r.height > 2 * R ? clamp(y, R, r.height - R) : r.height / 2]
    this.start = [at.x, at.y]
    this.at = performance.now()
    this.moved = false
    this.base.style.left = `${this.c[0]}px`
    this.base.style.top = `${this.c[1]}px`
    this.zone.classList.add('on')
    this.track(e)
  }

  private move = (e: PointerEvent) => { if (e.pointerId === this.id) this.track(e) }

  private track(e: PointerEvent) {
    const at = toUi(e.clientX, e.clientY)
    const dx = at.x - this.box.left - this.c[0]
    const dy = at.y - this.box.top - this.c[1]
    if (!this.moved && Math.hypot(at.x - this.start[0], at.y - this.start[1]) > TAP_SLOP) this.moved = true
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
  /** Leave gamepad mode (back to the controller it came from). */
  exit: () => void
  /** Open the controller catalogue, to switch to any controller. */
  controllers?: () => void
  /** Enter fullscreen where the platform allows it; called from a pointerup. */
  fullscreen?: () => void
  /** The profile in effect changed: the host suggested another, or the person picked one. */
  profile?: (id: ProfileId) => void
  /** Share the neutral with calibrated sim workspaces when a motion utility starts. */
  position?: () => void
  recenter?: () => void
  scope?: () => void
}

/** What the host declared about itself: its name, and the catalogue fields of its layout. */
export interface HostInfo { name: string; profile?: string; utilities?: string[] }

/**
 * Gamepad mode: a full-screen Xbox-style controller (floating sticks with click, D-pad, ABXY, bumpers, analog triggers,
 * View / Menu / Guide) with the catalogue's Motion utilities: gyro Aim, tilt Steer and the Wii-style Point, each routed
 * by the active profile (CATALOGUE §2–3). Streams PAD packets (packages/core/src/pad.ts) in place of STATE while it is
 * active, and POINTER packets beside them while a pointing utility is on.
 */
/**
 * The screen turned (portrait to landscape, say): the level Steer holds and the centre Point aims from were taken in the
 * old screen frame, so they're taken again once the phone has settled in the new one. step() says when.
 */
export class TurnWatch {
  private angle = -1
  private due = 0
  constructor(private readonly settleMs = 400) {}

  /** The screen's angle (degrees) at `now` (ms): true when it's time to take the level again. */
  step(angle: number, now: number): boolean {
    if (angle !== this.angle) {
      if (this.angle >= 0) this.due = now + this.settleMs
      this.angle = angle
    }
    if (!this.due || now < this.due) return false
    this.due = 0
    return true
  }

  /** Forget the angle (the gamepad left): the next one is where it starts. */
  reset() { this.angle = -1; this.due = 0 }
}

export class GamepadMode {
  private controlReach: Reach | null = null
  setControlReach(reach: Reach | null) { this.controlReach = reach }
  setControlScope(scope: 'object' | 'scene', target = '') {
    const button = this.el?.querySelector<HTMLButtonElement>('[data-act="scope"]')
    if (!button) return
    button.hidden = !this.controlReach
    button.setAttribute('aria-pressed', String(scope === 'scene'))
    // Drawn as what it reaches: the object held, or the whole scene (and then what A would take).
    const wide = scope === 'scene'
    if (button.dataset.scope !== scope) { button.dataset.scope = scope; setMarkup(button.querySelector('.gp-scope-ic')!, wide ? ICONS.scene : ICONS.cube) }
    button.querySelector('span')!.textContent = wide ? 'Scene' : 'Object'
    const hint = button.querySelector('small')!
    hint.hidden = !wide || !target
    hint.textContent = `A: take ${target}`
    button.setAttribute('aria-label', wide && target ? `Scene scope, A takes ${target}` : 'Scene scope')
    this.paintChips()
  }
  setPosition() { this.relevel() }
  get spatialActive() { return this.active && this.on.size > 0 }
  get spatialPointer() { return this.active && (this.on.has(Utility.aim) || this.on.has(Utility.point)) }
  private el: HTMLElement | null = null
  private active = false
  private readonly pad = emptyPad()
  private readonly buf = new ArrayBuffer(PAD_BYTES)
  private readonly ptr = emptyPointer()
  private readonly ptrBuf = new ArrayBuffer(POINTER_BYTES)
  /** Button bits per pointer; each pointer is captured by exactly one control. */
  private readonly held = new Map<number, number>()
  private clicks: { bit: number; until: number }[] = []
  private sticks: Stick[] = []
  private readonly trig: Vec2 = [0, 0]
  /** The triggers as physical buttons hold them (all the way, or not at all). */
  private readonly hwTrig: Vec2 = [0, 0]
  private resets: (() => void)[] = []
  private remeasures: (() => void)[] = []
  private readonly on = new Set<MotionUtility>()
  /** Utilities a profile switched on before the phone had motion to drive them: they come on with its first sample. */
  private readonly pending = new Set<MotionUtility>()
  private readonly turns = new TurnWatch()
  private offered: MotionUtility[] = [...MOTION_UTILITIES]
  private host: HostInfo = { name: '' }
  private profileId: ProfileId = 'default'
  private profile: Profile = PROFILES.default
  private inputs: MotionInputs = { rates: null, tilt: null }
  private mouseAcc: Vec2 = [0, 0]
  private readonly smoother = new GyroSmoother()
  private readonly tilt = new TiltStick(4, 30, 1) // linear: the profile's curve shapes it
  private readonly wii = new WiiPointer()
  private lastSend = 0
  private handoffUntil = 0
  private rumbleTimer: ReturnType<typeof setTimeout> | undefined
  private sheet: HTMLElement | null = null

  constructor(private readonly deps: GamepadDeps) {
    document.addEventListener('visibilitychange', () => {
      if (!this.active) return
      if (document.visibilityState === 'hidden') { this.releaseAll(); this.sendNeutral() }
      else this.relevel()
    })
    addEventListener('resize', () => { for (const f of this.remeasures) f() })
    this.applyProfile(this.profileId)
  }

  /** Build the layer inside the control surface. Call again whenever the surface is rebuilt. */
  mount(surface: HTMLElement) {
    this.releaseAll()
    this.resets = []
    this.remeasures = []
    insertMarkup(surface, 'beforeend', layerHtml())
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
    el.querySelector<HTMLElement>('[data-act="exit"]')!.onclick = () => { tick(); this.deps.exit() }
    el.querySelector<HTMLElement>('[data-act="controllers"]')!.onclick = () => { tick(); this.deps.controllers?.() }
    this.back = ''
    el.querySelector<HTMLElement>('[data-act="settings"]')!.onclick = () => { tick(); this.deps.openSettings() }
    el.querySelector<HTMLElement>('[data-act="profile"]')!.onclick = () => { tick(); this.openProfiles() }
    el.querySelector<HTMLElement>('[data-act="centre"]')!.onclick = () => {
      tick()
      if (this.controlReach && this.deps.recenter) this.deps.recenter()
      else { this.recentre(); this.deps.toast('Centred') }
    }
    el.querySelector<HTMLElement>('[data-act="scope"]')!.onclick = () => { tick(); this.deps.scope?.() }
    this.renderChips()
    el.hidden = !this.active
    surface.classList.toggle('gp-on', this.active)
    document.documentElement.classList.toggle('gp-mode', this.active)
  }

  /** Called on every surface render: show or hide the layer. */
  sync(o: { active: boolean }) {
    this.el?.classList.toggle('no-motion', !this.deps.motion.q)
    this.setActive(o.active)
  }

  private back: string | null = ''
  /** The way back: drawn as the controller it returns to (an icon's markup), and named for it; null, none. */
  setBack(icon: string | null, name: string | null) {
    const b = this.el?.querySelector<HTMLElement>('[data-act="exit"]')
    if (!b || this.back === name) return
    this.back = name
    b.hidden = !icon || !name
    if (!icon || !name) return
    setMarkup(b, icon)
    b.setAttribute('aria-label', `Back to ${name}`)
    b.title = `Back to ${name}`
  }

  /**
   * The steering wheel is this gamepad with the Driving profile (CATALOGUE §9.1): picking it applies Driving, and picking
   * the gamepad from it goes back to the screen's own suggestion (or Default). `remember`: keep it as this person's
   * choice for this screen, as a pick in the profile sheet is; a switch the phone makes by itself isn't.
   */
  setWheel(on: boolean, remember = true) {
    if (on === (this.profileId === 'driving')) return
    const suggested = isProfileId(this.host.profile) ? this.host.profile : null
    const id: ProfileId = on ? 'driving' : suggested && suggested !== 'driving' ? suggested : 'default'
    if (remember) this.chooseProfile(id)
    else { this.applyProfile(id); this.changed() }
  }

  /**
   * The host introduced itself or changed its layout: offer only the utilities it accepts, and apply its suggested
   * profile unless the user chose one for this host (and this suggestion) before.
   */
  setHost(h: HostInfo) {
    this.host = h
    this.offered = offeredMotion(h.utilities)
    for (const u of [...this.on]) if (!this.offered.includes(u)) this.on.delete(u)
    for (const u of [...this.pending]) if (!this.offered.includes(u)) this.pending.delete(u)
    const suggested = isProfileId(h.profile) ? h.profile : null
    this.applyProfile(activeProfile(store.get(profileKey(h.name, suggested)), suggested))
    this.renderChips()
  }

  /**
   * One tick of the state pump (each motion sample, or every 16 ms without motion). Sends a PAD packet: about 60 Hz while
   * anything is held or motion is steering, 15 Hz at rest. Returns true when the tick is fully handled and no STATE should
   * be sent. Right after entering gamepad mode it returns false for a moment, so the caller's STATE packets (which now
   * carry mode = gamepad) tell the host to stop applying the previous mode's gyro or tilt; after that only PAD is sent.
   */
  pump(dtMs = 16.7): boolean {
    if (!this.active) return false
    const now = performance.now()
    this.sampleMotion(dtMs)
    this.compose(now)
    const [lx, ly, rx, ry] = this.pad.axes
    const L = this.contributes('stick.left') || (this.on.has(Utility.steer) && this.profile.steer.route === 'stick.wheel')
    const R = this.contributes('stick.right') || (this.on.has(Utility.steer) && this.profile.steer.route === 'stick.fly')
    this.sticks[0]?.show(L ? [lx, ly] : null)
    this.turnWheel()
    this.sticks[1]?.show(R ? [rx, ry] : null)
    const gap = now - this.lastSend
    if (gap >= MIN_GAP_MS && (gap >= IDLE_MS || this.busy(now))) this.sendPad(now)
    return now >= this.handoffUntil
  }

  /**
   * A physical button (a key, a pad's button, a headset press) holding a pad button (./buttons.ts). The triggers go all
   * the way down, as a pedal does.
   */
  hardware(button: number, down: boolean) {
    const key = -1000 - button
    if (down) this.held.set(key, bit(button))
    else this.held.delete(key)
    if (button === PadButton.LT || button === PadButton.RT) this.hwTrig[button === PadButton.LT ? 0 : 1] = down ? 1 : 0
    this.changed()
  }

  /** A physical button with no release of its own (a headset press, Back): a click of a pad button. */
  tap(button: number) { this.click(button) }

  /** Host rumble (dual-rumble semantics). Android vibrates; iOS web pages can't vibrate outside a tap, so the layer's border pulses. */
  rumble(strong: number, weak: number, ms: number) {
    if (!feedbackEnabled() || document.hidden) return
    const s = clamp(Number(strong) || 0, 0, 1)
    const w = clamp(Number(weak) || 0, 0, 1)
    const d = clamp(Number(ms) || 0, 0, MAX_RUMBLE_MS)
    gamepadFeedback(s, w, d)
    if (hapticsKind() === 'vibrate') { navigator.vibrate(rumblePattern(s, w, d)); return }
    this.pulse(Math.max(s, w), d)
  }

  // ---- internals --------------------------------------------------------------------

  /** A different screen starts with no buttons, sticks or pending taps from this one. */
  releaseConnection() {
    ++this.connectionGeneration
    this.releaseAll()
    this.sendNeutral()
    this.pulse(0, 0)
  }

  private connectionGeneration = 0

  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    this.turns.reset()
    const el = this.el
    if (el) { el.hidden = !on; el.parentElement?.classList.toggle('gp-on', on) }
    document.documentElement.classList.toggle('gp-mode', on)
    if (on) {
      this.handoffUntil = performance.now() + HANDOFF_MS
      this.lastSend = 0
      this.relevel()
    } else {
      this.closeSheet()
      this.releaseAll()
      this.pulse(0, 0)
      // Leave the host a neutral pad, so nothing keeps moving until its pad times out.
      this.sendNeutral()
      const connection = this.connectionGeneration
      for (const ms of [40, 100]) setTimeout(() => { if (!this.active && connection === this.connectionGeneration) this.sendNeutral() }, ms)
    }
  }

  /** The pose right now is neutral: level for Steer, and the centre of the screen for Point. */
  private relevel() {
    this.smoother.reset()
    this.recentre()
  }

  private recentre() {
    const { motion } = this.deps
    if (!motion.q) return
    this.deps.position?.()
    if (this.on.has(Utility.steer)) this.tilt.capture(motion.up())
    if (this.on.has(Utility.point)) { this.wii.recenter(motion.q); this.ptr.gen = (this.ptr.gen + 1) & 0xff }
    this.mouseAcc = [0, 0]
  }

  private toggle(u: MotionUtility, on = !this.on.has(u)) {
    const { motion } = this.deps
    this.pending.delete(u)
    if (on && !this.on.has(u)) {
      if ((u === Utility.aim && !motion.hasGyro) || !motion.q) return this.deps.toast('Motion is off on this phone')
      this.on.add(u)
      this.deps.position?.()
      if (u === Utility.aim) this.smoother.reset()
      if (u === Utility.steer) this.tilt.capture(motion.up()) // the pose right now is straight ahead
      if (u === Utility.point) { this.wii.recenter(motion.q); this.ptr.gen = (this.ptr.gen + 1) & 0xff }
    } else if (!on) this.on.delete(u)
    this.paintChips()
    this.changed()
  }

  /** Does any motion utility currently feed this stick? */
  private contributes(route: Route): boolean {
    return (this.on.has(Utility.aim) && this.profile.aim.route === route) || (this.on.has(Utility.steer) && this.profile.steer.route === route)
  }

  private get pointing() { return this.on.has(Utility.point) && !!this.deps.motion.q }
  private get gyroMouse() { return this.on.has(Utility.aim) && this.profile.aim.route === 'mouse' && this.deps.motion.hasGyro }

  private sampleMotion(dtMs: number) {
    const { motion, settings } = this.deps
    // Motion came: what the profile switched on starts now (its level is the pose right now).
    if (this.pending.size && motion.q) this.switchPending()
    if (this.turns.step(screenAngle(), performance.now())) this.recentre()
    this.smoother.smoothBelow = 4 + 8 * settings.smooth
    this.wii.setSteadiness(settings.smooth)
    this.inputs = { rates: null, tilt: null }
    if (this.on.has(Utility.aim) && motion.hasGyro && motion.flowing) this.inputs.rates = this.smoother.apply(...playerSpaceRates(motion.gyro, motion.up()))
    if (this.on.has(Utility.steer) && motion.q) this.inputs.tilt = this.controlReach ? reachOf(this.tilt.angles(motion.up()), this.controlReach, 3) : this.tilt.stick(motion.up(), 1)
    if (this.pointing) this.wii.update(motion.q!, dtMs / 1000)
    const { axes, mouse } = composeSticks(this.sticks[0]?.value ?? [0, 0], this.sticks[1]?.value ?? [0, 0], this.inputs, this.profile, settings.gain)
    this.pad.axes = axes
    if (mouse) { this.mouseAcc[0] += (mouse[0] * dtMs) / 1000; this.mouseAcc[1] += (mouse[1] * dtMs) / 1000 }
  }

  private compose(now: number) {
    const p = this.pad
    p.triggers = [Math.max(this.trig[0], this.hwTrig[0]), Math.max(this.trig[1], this.hwTrig[1])]
    let m = 0
    for (const b of this.held.values()) m |= b
    this.clicks = this.clicks.filter((c) => c.until > now)
    for (const c of this.clicks) m |= bit(c.bit)
    p.buttons = m >>> 0
    p.flags = (this.on.has(Utility.aim) ? PadFlag.gyroAim : 0) | (this.on.has(Utility.steer) ? PadFlag.tiltSteer : 0) | (this.pointing ? PadFlag.point : 0)
  }

  private busy(now: number) {
    return this.on.size > 0 || this.held.size > 0 || this.trig[0] > 0 || this.trig[1] > 0 || this.hwTrig[0] > 0 || this.hwTrig[1] > 0 ||
      this.sticks.some((s) => s.touching) || this.clicks.some((c) => c.until > now)
  }

  /** Same conventions as STATE: u16 seq per packet, capture time in µs on the session clock. A POINTER follows while pointing. */
  private sendPad(now: number) {
    const p = this.pad
    p.seq = (p.seq + 1) & 0xffff
    p.t = Math.round((now - this.deps.t0) * 1000) >>> 0
    if (this.deps.send(encodePad(p, this.buf))) this.lastSend = now
    if (this.pointing || this.gyroMouse) this.sendPointer(p.t)
  }

  /** Point: the absolute Wii aim (scaled by its gain). Aim on the mouse route: the integrated turn, only its change matters. */
  private sendPointer(t: number) {
    const q = this.ptr
    const s = this.profile.point
    q.seq = (q.seq + 1) & 0xffff
    q.t = t
    if (this.pointing) {
      q.flags = PointerFlag.valid | (s.edgeTurn ? PointerFlag.edgeTurn : 0)
      q.yaw = this.wii.aim[0] * s.gain
      q.pitch = this.wii.aim[1] * s.gain * (s.invertY ? -1 : 1)
    } else {
      q.flags = PointerFlag.valid | PointerFlag.relative
      q.yaw = this.mouseAcc[0]
      q.pitch = this.mouseAcc[1]
    }
    this.deps.send(encodePointer(q, this.ptrBuf))
  }

  private sendNeutral() {
    const p = this.pad
    p.buttons = 0
    p.axes = [0, 0, 0, 0]
    p.triggers = [0, 0]
    p.flags = 0
    p.seq = (p.seq + 1) & 0xffff
    p.t = Math.round((performance.now() - this.deps.t0) * 1000) >>> 0
    if (this.deps.send(encodePad(p, this.buf))) this.lastSend = performance.now()
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
    this.hwTrig[0] = this.hwTrig[1] = 0
  }

  // ---- profiles and the motion chips --------------------------------------------------

  private overrides(id: ProfileId): ProfileOverrides {
    try { return (JSON.parse(store.get(`obpal.motion.${id}`) ?? '{}') as ProfileOverrides) ?? {} } catch { return {} }
  }

  /** The profile in effect (CATALOGUE §3), which the phone names in mode{p}. */
  get profileInUse(): ProfileId { return this.profileId }

  /**
   * Make a profile current. Its `on` utilities the host offers switch on (CATALOGUE §3): at once where the phone can drive
   * them, else with its first motion sample (a phone whose sensors start late, or wait for Start). The rest stay as they
   * were.
   */
  private applyProfile(id: ProfileId) {
    const changed = id !== this.profileId
    this.profileId = id
    this.profile = resolveProfile(id, this.overrides(id))
    if (changed) {
      this.pending.clear()
      for (const u of this.profile.on) if (this.offered.includes(u) && !this.on.has(u)) this.pending.add(u)
      if (this.deps.motion.q) this.switchPending()
    }
    this.paintChips()
    if (changed) this.deps.profile?.(id)
  }

  /** Switch on what the profile asked for (Aim only with a gyro to drive it). */
  private switchPending() {
    const want = [...this.pending]
    this.pending.clear()
    for (const u of want) if (u !== Utility.aim || this.deps.motion.hasGyro) this.toggle(u, true)
  }

  /** The user picked a profile: remembered for this host and suggestion; picking the suggestion itself forgets the choice. */
  private chooseProfile(id: ProfileId) {
    const suggested = isProfileId(this.host.profile) ? this.host.profile : null
    store.set(profileKey(this.host.name, suggested), id === suggested ? null : id)
    this.applyProfile(id)
    this.changed()
  }

  private saveOverride(u: MotionUtility, patch: Partial<UtilitySettings>) {
    const key = utilityKey(u)
    const over = this.overrides(this.profileId)
    over[key] = { ...over[key], ...patch }
    store.set(`obpal.motion.${this.profileId}`, JSON.stringify(over))
    this.profile = resolveProfile(this.profileId, over)
    if (this.on.has(Utility.steer) && patch.route) this.tilt.capture(this.deps.motion.up())
    this.paintChips()
    this.changed()
  }

  private resetOverride(u: MotionUtility) {
    const over = this.overrides(this.profileId)
    delete over[utilityKey(u)]
    store.set(`obpal.motion.${this.profileId}`, JSON.stringify(over))
    this.profile = resolveProfile(this.profileId, over)
    this.paintChips()
    this.changed()
  }

  private renderChips() {
    const row = this.el?.querySelector<HTMLElement>('.gp-chips')
    if (!row) return
    setMarkup(row, this.offered.map((u) => html`<button class="gp-chip" data-chip="${u}" aria-pressed="false" aria-haspopup="dialog" title="${UTILITY_META[u].title}"><i class="gp-chip-ic"></i><span>${UTILITY_META[u].label}</span></button>`))
    row.querySelectorAll<HTMLElement>('[data-chip]').forEach((c) => this.bindChip(c, c.dataset.chip as MotionUtility))
    this.paintChips()
  }

  /** A tap toggles the utility; holding the chip opens its options. */
  private bindChip(el: HTMLElement, u: MotionUtility) {
    let id: number | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let opened = false
    const down = (e: PointerEvent) => {
      if (id !== null) return
      capture(el, e)
      id = e.pointerId
      opened = false
      el.classList.add('hold')
      timer = setTimeout(() => { opened = true; el.classList.remove('hold'); tick(true); swallowNextClick(); this.openOptions(u) }, LONG_PRESS_MS)
    }
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return
      id = null
      clearTimeout(timer)
      el.classList.remove('hold')
      if (!opened && e.type === 'pointerup') { tick(); this.toggle(u) }
    }
    listen(el, down, null, up)
  }

  private wheelTurn = NaN
  /** The steering wheel's own face (CATALOGUE §9.1): a wheel in the middle that turns as the phone is tilted to steer. */
  private turnWheel() {
    const w = this.el?.querySelector<HTMLElement>('.gp-wheel i')
    if (!w) return
    const deg = this.profileId === 'driving' && this.inputs.tilt ? Math.round(clamp(this.inputs.tilt[0], -1, 1) * 900) / 10 : 0
    if (deg === this.wheelTurn) return
    this.wheelTurn = deg
    w.style.transform = `rotate(${deg}deg)`
  }

  private paintChips() {
    const el = this.el
    if (!el) return
    el.classList.toggle('as-wheel', this.profileId === 'driving')
    const route = (u: MotionUtility) => this.profile[utilityKey(u)].route
    el.querySelectorAll<HTMLElement>('[data-chip]').forEach((c) => {
      const u = c.dataset.chip as MotionUtility
      c.setAttribute('aria-pressed', String(this.on.has(u)))
      c.dataset.route = route(u)
      const ic = u === Utility.aim && route(u) !== 'mouse' ? 'gyro' : u === Utility.steer && route(u).startsWith('stick.') && route(u) !== 'stick.fly' && route(u) !== 'stick.wheel' ? 'tilt' : ROUTE_META[route(u)].icon
      setMarkup(c.querySelector('.gp-chip-ic')!, ICONS[ic])
    })
    const prof = el.querySelector<HTMLElement>('[data-act="profile"]')
    if (prof) {
      setMarkup(prof, html`${ICONS[PROFILE_ICON[this.profileId]]}<span>${this.profile.name}</span>`)
      prof.setAttribute('aria-label', `Profile: ${this.profile.name}`)
    }
    const centre = el.querySelector<HTMLElement>('[data-act="centre"]')
    if (centre) {
      centre.hidden = !(this.controlReach || this.on.has(Utility.steer) || this.on.has(Utility.point))
      centre.setAttribute('aria-label', this.controlReach ? 'Set position' : 'Centre here')
      centre.title = this.controlReach ? 'Set position' : 'Centre here'
    }
  }

  // ---- sheets: utility options, profile picker --------------------------------------------

  private openSheet(label: string, body: Content): HTMLElement {
    this.closeSheet()
    const wrap = document.createElement('div')
    wrap.className = 'sheet-wrap gp-sheet-wrap'
    setMarkup(wrap, html`<div class="sheet gp-sheet glass" role="dialog" aria-label="${label}"><div class="grip" aria-hidden="true"></div>${body}</div>`)
    wrap.querySelector<HTMLButtonElement>('[data-act="done"]')?.addEventListener('click', () => this.closeSheet())
    document.body.appendChild(wrap)
    this.sheet = wrap
    this.sheetExits = sheetExits(wrap, () => this.closeSheet())
    return wrap
  }

  private sheetExits = () => {}

  private closeSheet() {
    const s = this.sheet
    if (!s) return
    this.sheet = null
    this.sheetExits()
    this.sheetExits = () => {}
    s.classList.add('out')
    setTimeout(() => s.remove(), 200)
  }

  /** A utility's options: route, sensitivity, deadzone jump, invert Y (and the edge turn for Point). */
  private openOptions(u: MotionUtility) {
    const key = utilityKey(u)
    const s = this.profile[key]
    const routes = ROUTES[u]
    const seg = routes.length > 1
      ? html`<div class="routes" role="radiogroup" aria-label="Route">${routes.map((r) => html`<button role="radio" data-route="${r}" aria-checked="${r === s.route}">${ICONS[ROUTE_META[r].icon]}<span>${ROUTE_META[r].label}</span></button>`)}</div>`
      : ''
    const jump = u !== Utility.point
      ? html`<label class="bb-field"><span>Deadzone jump</span><output id="gp-dz"></output><input class="bb-range" type="range" id="gp-dead" min="0" max="0.4" step="0.02"></label>`
      : ''
    const edge = u === Utility.point ? html`<label class="row"><input type="checkbox" id="gp-edge"> Edge turn</label>` : ''
    const wrap = this.openSheet(`${UTILITY_META[u].label} options`, html`
      <div class="sheet-title"><i class="gp-chip-ic">${ICONS[ROUTE_META[s.route].icon]}</i><h2>${UTILITY_META[u].label}</h2><span class="sheet-sub">${this.profile.name}</span></div>
      ${seg}
      <label class="bb-field"><span>Sensitivity</span><output id="gp-gv"></output><input class="bb-range" type="range" id="gp-gain" min="0.25" max="3" step="0.05"></label>
      ${jump}
      <label class="row"><input type="checkbox" id="gp-inv"> Invert Y</label>
      ${edge}
      <div class="row gap"><button class="btn" data-act="reset">Reset</button><button class="btn primary" data-act="done">Done</button></div>`)
    const $ = <T extends HTMLElement>(id: string) => wrap.querySelector<T>(`#${id}`)
    const gain = $<HTMLInputElement>('gp-gain')!
    const dead = $<HTMLInputElement>('gp-dead')
    const inv = $<HTMLInputElement>('gp-inv')!
    const edgeBox = $<HTMLInputElement>('gp-edge')
    const show = () => {
      const cur = this.profile[key]
      gain.value = String(cur.gain)
      if (dead) dead.value = String(cur.deadzone)
      inv.checked = cur.invertY
      if (edgeBox) edgeBox.checked = cur.edgeTurn
      $('gp-gv')!.textContent = `${Number(gain.value).toFixed(2).replace(/0$/, '')}×`
      if (dead) $('gp-dz')!.textContent = Number(dead.value).toFixed(2)
      wrap.querySelectorAll<HTMLElement>('[data-route]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.route === cur.route)))
      setMarkup(wrap.querySelector('.sheet-title .gp-chip-ic')!, ICONS[ROUTE_META[cur.route].icon])
      const fam = (window as Window & { BlackboxesFamily?: FamilyApi }).BlackboxesFamily
      fam?.syncRanges(wrap) // accent fill of the ranges
    }
    show()
    gain.oninput = () => { this.saveOverride(u, { gain: Number(gain.value) }); show() }
    if (dead) dead.oninput = () => { this.saveOverride(u, { deadzone: Number(dead.value) }); show() }
    inv.onchange = () => { tick(); this.saveOverride(u, { invertY: inv.checked }) }
    if (edgeBox) edgeBox.onchange = () => { tick(); this.saveOverride(u, { edgeTurn: edgeBox.checked }) }
    wrap.querySelectorAll<HTMLElement>('[data-route]').forEach((b) => { b.onclick = () => { tick(); this.saveOverride(u, { route: b.dataset.route as Route }); show() } })
    wrap.querySelector<HTMLElement>('[data-act="reset"]')!.onclick = () => { tick(); this.resetOverride(u); show() }
  }

  /** The profile picker: the built-ins, the host's suggestion marked. */
  private openProfiles() {
    const suggested = isProfileId(this.host.profile) ? this.host.profile : null
    const cells = PROFILE_IDS.map((id) => {
      const p = PROFILES[id]
      return html`<button class="pick" data-profile="${id}" aria-selected="${id === this.profileId}" title="${p.for}">
        <span class="pick-art">${ICONS[PROFILE_ICON[id]]}</span><span class="pick-name">${p.name}</span>${id === suggested ? html`<span class="pick-tag">suggested</span>` : ''}</button>`
    })
    const wrap = this.openSheet('Profile', html`
      <div class="sheet-title"><i class="gp-chip-ic">${ICONS[PROFILE_ICON[this.profileId]]}</i><h2>Profile</h2><span class="sheet-sub">${this.host.name || ''}</span></div>
      <div class="pick-grid profiles">${cells}</div>
      <p class="pick-for" id="gp-for">${PROFILES[this.profileId].for}</p>`)
    wrap.querySelectorAll<HTMLElement>('[data-profile]').forEach((b) => {
      b.onclick = () => {
        tick()
        this.chooseProfile(b.dataset.profile as ProfileId)
        wrap.querySelectorAll<HTMLElement>('[data-profile]').forEach((c) => c.setAttribute('aria-selected', String(c === b)))
        wrap.querySelector('#gp-for')!.textContent = this.profile.for
        setMarkup(wrap.querySelector('.sheet-title .gp-chip-ic')!, ICONS[PROFILE_ICON[this.profileId]])
        setTimeout(() => this.closeSheet(), 260)
      }
    })
  }

  // ---- pad controls ------------------------------------------------------------------------

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
      const r = uiRect(el)
      c = [r.left + r.width / 2, r.top + r.height / 2]
      dead = r.width * 0.12
    }
    const paint = () => {
      let m = 0
      for (const bits of ids.values()) m |= bits
      for (const a of arms) a.classList.toggle('on', (m & bit(Number(a.dataset.bit))) !== 0)
    }
    const aim = (e: PointerEvent) => {
      const at = toUi(e.clientX, e.clientY)
      const bits = dpadBits(at.x - c[0], at.y - c[1], dead)
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
    const measure = () => { const r = uiRect(el); top = r.top; height = r.height }
    const release = () => { id = null; this.trig[i] = 0; el.classList.remove('on'); fill.style.transform = '' }
    const down = (e: PointerEvent) => {
      if (id !== null) return
      capture(el, e)
      id = e.pointerId
      measure()
      el.classList.add('on')
      tick()
      this.trig[i] = triggerDepth(toUi(e.clientX, e.clientY).y, top, height)
      fill.style.transform = `scaleY(${this.trig[i]})`
      this.changed()
    }
    const move = (e: PointerEvent) => { if (e.pointerId === id) set(triggerDepth(toUi(e.clientX, e.clientY).y, top, height)) }
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
