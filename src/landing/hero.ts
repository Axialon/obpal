/**
 * The home page's hero is a bounce field (./field.ts, ./bounce.ts): the headline's letters stand as 3D blocks, seen
 * from overhead, and glass marbles roll and bounce on them. A marble has weight and never bounces by itself. The mouse
 * rolls the lime one and a click hops it onto the spot; on a phone a tap hops it, and once motion is on, tilting rolls
 * it like a marble on a tray and flicking the phone upward (screen level) tosses it. On a computer, phones that scan
 * the code each get a marble in their own colour: it rolls where the phone points, and jumps when the phone is
 * flicked upward or A is pressed. With nobody playing, the marble drops in, hops along the headline a word at a time
 * and comes to rest on its full stop. Every letter a marble lands on lights up; light them all and the headline
 * celebrates.
 *
 * The marbles sound like glass (./glass.ts), from the first click or tap on the page (browsers allow no sooner), and
 * a phone in hand feels every knock its marble takes.
 *
 * three.js loads only once the hero is on screen. Until then, and where WebGL isn't available, the headline is the
 * page's own text. Nothing draws while nothing moves.
 */
import { addActor, wake } from './ticker'
import { onTilt, onToss, recentre, startTilt, tiltOn } from './tilt'
import { hopTo } from './bounce'
import { createGlass, type GlassStats, type SoundState } from './glass'
import { Governor, ladder, pick, type Step } from './governor'
import type { Participant, Remote } from '@obpal/host'
import type { ScreenPointer } from '../viewer/pointer'
import type { Field, FieldOrb, Gfx, Hit, PadRect } from './field'
import { family } from '../family'

const LIME = '#c6ff34'
/** A hand that stops moving keeps steering its marble this long; then the marble rolls to a stop. */
const HOLD_MS = 2600
/** A phone's marble stops following it after this long without moving. */
const PHONE_REST_MS = 6000
/** A paired phone as a tray: its tilt stick at full (30° of tilt) pushes this hard (em/s²), as the phone page's does. */
const PHONE_TILT_PUSH = 15
/** Mode.tilt in @obpal/core (the page's first script doesn't load it). */
const TILT_MODE = 3
/** A tilt of this many degrees pushes the marble this hard (em/s² per degree): a marble on a tray. */
const TILT_PUSH = 0.55
/** A toss: the phone's up-speed (m/s) to the marble's (em/s), and the least and most a toss gives. */
const TOSS_GAIN = 6.5
const TOSS_MIN = 3
const TOSS_MAX = 9.2
/** A press of A tosses it this hard (em/s). */
const A_TOSS = 5.2
/** The opening: the marble falls in from this high (em) and hops a word at a time. */
const DROP = 2.4
/**
 * A letter's top, the marble's radius, and the id of the first button's footprint (field.ts TOP, ORB_R and PAD_ID,
 * repeated so the page's first script needn't load three.js).
 */
const TOP = 0.182
const R = 0.2
const PAD_ID = 1000
/** A phone feels at most one knock this often (ms). */
const BUZZ_GAP = 70
/** The page's buttons in the hero that marbles roll onto, and how far a marble's weight presses one (px). */
const PADS = '.cta .btn, [data-hint], [data-sound]'
const PRESS_PX = 1.5
/**
 * A knocked button rocks like a spring: how fast (6 swings a second), how soon it settles (in a fifth of a second), and
 * at most how far (degrees).
 */
const ROCK_W = 2 * Math.PI * 6
const ROCK_ZETA = 0.3
const ROCK_MAX = 4

/** The step ?quality= holds the field at, if any. */
function pinnedStep(steps: readonly Step[]): number | null {
  const q = new URLSearchParams(location.search).get('quality')
  const at = q === null ? -1 : pick(steps, q)
  return at < 0 ? null : at
}

export interface Hero {
  /** Phones join through this remote (a computer's pairing card), each with its own marble. */
  attach(remote: Remote, pointer: typeof ScreenPointer): void
  /** Start following the phone's tilt and tosses (on a phone; iOS asks first, from a tap). */
  tilt(): Promise<boolean>
  readonly tilting: boolean
  /** The marbles' sound (./glass.ts): on, blocked (waiting for a click or a tap), off, or none. */
  readonly sound: SoundState
  /** The sound button was pressed (a click: the sound can start right there). */
  toggleSound(): void
  /** Called when the sound's state changes, and once the field is up (before it, there's nothing to hear). */
  onSound: ((s: SoundState) => void) | null
  /** The sound's state, hits and output level (the ?debug=audio readout, tests). */
  audio(): GlassStats
  /** Where each marble is on screen, how lit, how high it is (em, above the floor) and what it's on (for tests). */
  tips(): { id: string; x: number; y: number; life: number; h: number; on: number; held: boolean }[]
  /** Where the full stop's landing spot is on screen (for tests), once the field is up. */
  dot(): { x: number; y: number } | null
  /** The buttons marbles can roll onto now, in the order tips() counts them (on: 1000 + index): their text (tests). */
  pads(): string[]
  /**
   * A marble's outline as drawn (hero px: its extreme points), and the play area its outline keeps to: the hero's
   * sides, and top and bottom (tests).
   */
  outline(id: string): { left: number; right: number; top: number; bottom: number; area: { left: number; right: number; top: number; bottom: number } } | null
  /** How the field draws (the ?debug=gfx readout, tests): its canvas and buffer, and the governor's step. */
  gfx(): (Gfx & { level: number; steps: Step[]; pinned: boolean }) | null
}

export function mountHero(hero: HTMLElement, stage: HTMLCanvasElement, title: HTMLElement, opts: { still: boolean; onInput?: () => void; meter?: boolean }): Hero {
  const still = opts.still
  const coarse = matchMedia('(pointer: coarse)').matches
  let field: Field | null = null
  let visible = true
  let W = 1, H = 1
  const local = { x: 0, y: 0, at: -1e9, any: false }
  /** Where a click hopped the marble: it stays there until the mouse moves on (screen px of the click, and the spot). */
  let anchor: { sx: number; sy: number; x: number; z: number } | null = null
  let tiltPush: [number, number] | null = null
  let tiltAt = -1e9
  let tossAt = -1e9
  /** The opening is playing (the marble's route runs it; this is whether it's still going). */
  let tour = false
  const glass = createGlass({ meter: opts.meter })
  glass.onState = (s) => { if (field) heroApi.onSound?.(s) }
  // A click, tap or key press is the moment a browser lets sound start: offered to the sound right there, inside the
  // event (Safari allows it nowhere else). On a computer, any on the page; on a phone, only playing in the hero (not
  // browsing, or following a link: starting sound there could pause the person's own music). The sound button decides
  // for itself.
  const unlock = (e: Event) => {
    const t = e.target as Element | null
    if (t?.closest?.('[data-sound]')) return
    if (coarse && (!t || !hero.contains(t) || t.closest('a, [data-send]'))) return
    glass.gesture()
  }
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click']) addEventListener(type, unlock, { capture: true, passive: true })

  /** The headline as the page wraps it: its lines of text, and the box its letters fill (hero px). */
  function measure() {
    const hr = hero.getBoundingClientRect()
    const range = document.createRange()
    const words: { text: string; top: number }[] = []
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const t = walker.currentNode as Text
      for (const m of t.data.matchAll(/\S+/g)) {
        range.setStart(t, m.index!)
        range.setEnd(t, m.index! + m[0].length)
        words.push({ text: m[0], top: Math.round(range.getBoundingClientRect().top) })
      }
    }
    const lines: string[] = []
    let top = NaN
    for (const w of words) {
      if (!(Math.abs(w.top - top) <= 4)) { lines.push(w.text); top = w.top } else lines[lines.length - 1] += ` ${w.text}`
    }
    range.selectNodeContents(title)
    const rects = [...range.getClientRects()].filter((q) => q.width > 0 && q.height > 0)
    const box = { x: 0, y: 0, w: hr.width, h: hr.height }
    if (rects.length) {
      box.x = Math.min(...rects.map((q) => q.left)) - hr.left
      box.y = Math.min(...rects.map((q) => q.top)) - hr.top
      box.w = Math.max(...rects.map((q) => q.right)) - hr.left - box.x
      box.h = Math.max(...rects.map((q) => q.bottom)) - hr.top - box.y
    }
    return { lines: lines.length ? lines : [title.textContent ?? ''], box, W: hr.width, H: hr.height }
  }

  function layout() {
    if (!field) return
    const m = measure()
    W = m.W; H = m.H
    // The ladder for this size first, so the canvas is never drawn past its pixel budget, not even for a frame.
    rescale()
    field.layout(m.lines, W, H, m.box)
    const play = playArea()
    field.play(play.top, play.bottom)
    field.render()
  }

  /**
   * What of the hero the marbles may use: what's on screen with the page at its top. Below the page's bar where it
   * covers the hero's top (a marble under it would be hidden), down to the bottom of the screen with the browser's own
   * bars showing (100svh), or the hero's bottom if that comes first. (On a phone the hero is taller than the screen.)
   */
  function playArea() {
    const hr = hero.getBoundingClientRect()
    const docTop = hr.top + scrollY
    // The bar is the page's first thing: with the page at its top it covers 0 … its height.
    const bar = document.querySelector<HTMLElement>('header.top')
    const top = bar ? Math.max(0, bar.offsetHeight - docTop) : 0
    return { top, bottom: Math.min(hr.height, screenHeight() - docTop) }
  }
  let probe: HTMLElement | null = null
  /** The screen's height with the browser's bars showing (100svh: at the top of the page, they are). */
  function screenHeight() {
    if (!probe) {
      probe = document.createElement('div')
      probe.setAttribute('aria-hidden', 'true')
      probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none'
      document.body.appendChild(probe)
    }
    return probe.getBoundingClientRect().height || innerHeight
  }

  const me = () => field!.orb('me', LIME)
  /** The player takes over from the opening. */
  function takeOver() {
    if (tour && field) { const o = me().orb; o.route = []; o.flying = false; o.aim = null }
    tour = false
    local.any = true
    opts.onInput?.()
  }

  // ---- your own hand: the mouse, a tap, the phone's tilt and tosses ----

  const heroAt = (e: PointerEvent) => { const r = hero.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  /** Pressing a button or a link is that, not playing. */
  const onControl = (e: Event) => !!(e.target as Element | null)?.closest?.('a, button')
  // The mouse rolls the marble after it; a click (or a tap) hops it onto the spot. Touching to scroll leaves it be.
  let press: { x: number; y: number; t: number } | null = null
  hero.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return
    const p = heroAt(e)
    local.x = p.x; local.y = p.y; local.at = performance.now()
    if (anchor && Math.hypot(p.x - anchor.sx, p.y - anchor.sy) > 10) anchor = null
    takeOver()
    wake()
  }, { passive: true })
  const hop = (e: PointerEvent) => {
    if (!field) return
    const p = heroAt(e)
    takeOver()
    // Onto the letter clicked (or right by), at its landing spot; it stays there until the mouse moves on.
    const spot = field.spotAt(p.x, p.y)
    hopTo(me().orb, spot)
    anchor = { sx: p.x, sy: p.y, ...spot }
    // A tap has no hover to follow afterwards: the marble stays where it lands.
    if (e.pointerType !== 'mouse') { local.at = -1e9; anchor = null }
    wake()
  }
  hero.addEventListener('pointerdown', (e) => {
    if (onControl(e)) return
    if (e.pointerType === 'mouse') { if (e.button === 0) hop(e) } else press = { x: e.clientX, y: e.clientY, t: e.timeStamp }
  }, { passive: true })
  hero.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse' && !onControl(e) && press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10 && e.timeStamp - press.t < 350) hop(e)
    press = null
  }, { passive: true })
  hero.addEventListener('pointercancel', () => { press = null }, { passive: true })

  // The phone's tilt (once it's on) rolls the lime marble like a marble on a tray, once the opening has finished;
  // flicking the phone upward tosses it.
  onTilt((t) => {
    if (!visible || tour) return
    tiltPush = [t.x * TILT_PUSH, t.y * TILT_PUSH]
    if (t.wake) { tiltAt = performance.now(); local.any = true; opts.onInput?.(); wake() }
  })
  onToss((v) => {
    if (!visible || !field) return
    takeOver()
    tossAt = performance.now()
    field.toss(me(), tossSpeed(v))
    wake()
  })
  const tossSpeed = (v: number) => Math.max(TOSS_MIN, Math.min(TOSS_MAX, v * TOSS_GAIN))

  // ---- phones on a computer: one marble each, rolling where it points ----

  let remote: Remote | null = null
  let Pointer: typeof ScreenPointer | null = null
  const pointers = new Map<string, ScreenPointer>()
  const phones = new Map<string, { at: number; gone: boolean; buzzAt: number; pointing: boolean }>()
  /** Colours phones picked for their marbles (their accent), over their seats' own. */
  const colors = new Map<string, string>()
  function join(p: Participant) {
    phones.set(p.id, { at: performance.now(), gone: false, buzzAt: 0, pointing: false })
    if (!pointers.has(p.id)) pointers.set(p.id, new Pointer!())
    wake()
  }
  function readPhones(now: number) {
    if (!remote || !field) return
    for (const p of remote.participants) {
      if (!phones.has(p.id) || phones.get(p.id)!.gone) join(p)
      const ph = phones.get(p.id)!
      const f = remote.consumeOf(p.id, now)
      const st = pointers.get(p.id)!.step(f.aim, f.pad1, W, H)
      const o = field.orb(p.id, colors.get(p.id) ?? p.color)
      // Held as a tray (Tilt, with its gyro on), the phone's tilt rolls its marble; pointed (Point, or a finger on
      // its trackpad), the marble rolls to where it points.
      const push: [number, number] = f.mode === TILT_MODE ? [f.tilt[0] * PHONE_TILT_PUSH, f.tilt[1] * PHONE_TILT_PUSH] : [0, 0]
      const tilted = Math.hypot(push[0], push[1]) > 0.05
      const pointed = Math.abs(st.dx) + Math.abs(st.dy) > 0.25
      if (tilted || pointed) ph.at = now
      if (tilted) ph.pointing = false
      else if (pointed) ph.pointing = true
      o.live = now - ph.at < PHONE_REST_MS
      o.push = tilted ? push : null
      o.orb.target = o.live && ph.pointing ? field.pointAt(Math.max(0, Math.min(W, st.x)), Math.max(0, Math.min(H, st.y))) : null
      if (o.live) o.orb.resting = false
    }
  }
  function phoneToss(who: Participant, vy: number) {
    if (!field || !visible) return
    const ph = phones.get(who.id)
    if (ph) ph.at = performance.now()
    field.toss(field.orb(who.id, colors.get(who.id) ?? who.color), vy)
    wake()
  }

  // ---- the page's buttons: steps the marbles roll up onto and off (./field.ts), which answer them ----

  // Each button in the hero is a raised block in the marbles' world, where it is on the page (measured every frame, so
  // a button that moves takes its marble with it). The marbles draw above it and its dots stay under it. It answers a
  // marble with a light where the marble is (brighter the nearer, in its colour), a small press under its weight, a
  // dip and a rock (toward where it was struck) when one lands on it or knocks its side, and a glass tap. It never does
  // its own thing for a marble: only a click or a tap does.
  const padEls = [...hero.querySelectorAll<HTMLElement>(PADS)]
  const padState = new Map(padEls.map((el) => [el, { press: 0, pressV: 0, glow: 0, flash: 0, radius: NaN, shown: '', rx: { x: 0, v: 0 }, ry: { x: 0, v: 0 } }]))
  /** Each button's box (hero px), in the order the field counts them; empty while one isn't there to stand on. */
  let padRects: PadRect[] = []
  let padDepth = -1
  function measurePads(): PadRect[] {
    const hr = hero.getBoundingClientRect()
    padRects = padEls.map((el) => {
      // Hidden, or on its way out (the hint, once played with): nothing to stand on.
      if (el.hidden || el.classList.contains('gone') || !el.getClientRects().length) return { x: 0, y: 0, w: 0, h: 0, r: 0 }
      const st = padState.get(el)!
      if (Number.isNaN(st.radius)) st.radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
      const r = el.getBoundingClientRect()
      // Where it is at rest (a press moves it down a touch).
      return { x: r.left - hr.left, y: r.top - hr.top - st.press * PRESS_PX, w: r.width, h: r.height, r: Math.min(st.radius, r.height / 2) }
    })
    return padRects
  }
  function padHit(h: Hit) {
    const st = h.pad === undefined ? undefined : padState.get(padEls[h.pad])
    const b = h.pad === undefined ? undefined : padRects[h.pad]
    if (!st || !b || !field) return
    st.pressV += 2 + 7 * h.strength
    st.flash = Math.max(st.flash, 0.55 + 0.45 * h.strength)
    if (still) return
    // It rocks: the side struck goes down (away from the eye), by half a degree for a gentle knock up to 3° for the
    // hardest (a kick of the spring's speed: degrees a second).
    const p = field.project(h.x, h.y, h.z)
    const dx = Math.max(-1, Math.min(1, (p.x - (b.x + b.w / 2)) / (b.w / 2))), dy = Math.max(-1, Math.min(1, (p.y - (b.y + b.h / 2)) / (b.h / 2)))
    const k = ROCK_W * (0.6 + 2.4 * h.strength)
    st.ry.v += k * dx
    st.rx.v -= k * dy
  }
  /** Each button's light and press, from the marbles on it and near it. Returns whether any is still settling. */
  function answerPads(dt: number): boolean {
    if (!field) return false
    const f = field
    let busy = false
    const orbs = f.orbs().map((o) => {
      const p = f.project(o.orb.x, o.orb.y, o.orb.z)
      const e = f.project(o.orb.x + o.orb.r, o.orb.y, o.orb.z)
      return { o, p, rad: Math.max(4, Math.hypot(e.x - p.x, e.y - p.y)), s: f.surface(o.orb.x, o.orb.z) }
    })
    padEls.forEach((el, i) => {
      const st = padState.get(el)!
      const b = padRects[i]
      if (!b) return
      let near: { o: FieldOrb; x: number; y: number; k: number } | null = null
      let weight = 0
      for (const { o, p, rad, s } of b.w > 0 ? orbs : []) {
        const on = s.id === PAD_ID + i && o.orb.y - o.orb.r - s.h < 0.02
        if (on) weight++
        // How near it is: 1 on it or over it, fading out a few radii away.
        const d = Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.w), Math.max(b.y - p.y, 0, p.y - b.y - b.h))
        const k = on ? 1 : Math.max(0, 1 - d / (rad * 3)) * (0.35 + 0.65 * o.life)
        if (!near || k > near.k) near = { o, x: p.x - b.x, y: p.y - b.y, k }
      }
      const goal = near ? near.k : 0
      st.glow += (goal - st.glow) * (1 - Math.exp(-dt * 10))
      st.flash *= Math.exp(-dt * 5)
      // Under a marble's weight it gives a little; a landing dips it, and it springs back. A knock rocks it, a few
      // swings in a fifth of a second.
      const rest = weight ? 0.4 : 0
      st.pressV += (-(st.press - rest) * 380 - st.pressV * 26) * dt
      st.press = Math.max(-0.4, Math.min(1.4, st.press + st.pressV * dt))
      for (const w of [st.rx, st.ry]) {
        for (let left = dt; left > 1e-6; left -= 1 / 240) {
          const h = Math.min(left, 1 / 240)
          w.v += (-ROCK_W * ROCK_W * w.x - 2 * ROCK_ZETA * ROCK_W * w.v) * h
          w.x = Math.max(-ROCK_MAX, Math.min(ROCK_MAX, w.x + w.v * h))
        }
      }
      const lit = Math.min(1, Math.max(st.glow, st.flash))
      const c = near?.o.color
      const rock = Math.hypot(st.rx.x, st.ry.x)
      const shown = `${near ? `${near.x.toFixed(0)},${near.y.toFixed(0)}` : ''}|${lit.toFixed(2)}|${st.press.toFixed(2)}|${c ? c.getHexString() : ''}|${st.rx.x.toFixed(2)},${st.ry.x.toFixed(2)}`
      if (shown !== st.shown) {
        st.shown = shown
        const s = el.style
        if (near) { s.setProperty('--orb-x', `${near.x.toFixed(0)}px`); s.setProperty('--orb-y', `${near.y.toFixed(0)}px`) }
        if (c) s.setProperty('--orb-rgb', `${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)}`)
        s.setProperty('--orb-glow', lit.toFixed(2))
        // Pressed, the block sinks and its side shows that much less.
        const sink = Math.max(0, st.press * PRESS_PX)
        s.translate = Math.abs(st.press) < 0.005 ? '' : `0 ${(st.press * PRESS_PX).toFixed(2)}px`
        s.setProperty('--sink', `${sink.toFixed(2)}px`)
        s.rotate = rock < 0.02 ? '' : `${(st.rx.x / rock).toFixed(3)} ${(st.ry.x / rock).toFixed(3)} 0 ${rock.toFixed(2)}deg`
      }
      if (Math.abs(st.press - rest) > 0.005 || Math.abs(st.pressV) > 0.02 || st.flash > 0.01 || Math.abs(st.glow - goal) > 0.01 || rock > 0.02 || Math.abs(st.rx.v) + Math.abs(st.ry.v) > 0.5) busy = true
    })
    return busy
  }
  // A button that changes (it goes, it appears, its words change, the words above it reflow) while nothing moves wakes
  // the marbles, which find it where it is now.
  const padWatch = new MutationObserver(() => wake())
  const padSize = new ResizeObserver(() => wake())
  for (const el of padEls) { padWatch.observe(el, { attributes: true, attributeFilter: ['class', 'hidden', 'data-state'] }); padSize.observe(el) }
  const copy = hero.querySelector('.hero-copy')
  if (copy) padSize.observe(copy)

  // ---- what a hit sounds like, and the knock felt in the hand ----

  function onHit(h: Hit) {
    if (!field) return
    if (h.kind === 'button') padHit(h)
    const p = field.project(h.x, h.y, h.z)
    glass.hit(h.kind, h.speed, (p.x / Math.max(1, W)) * 2 - 1, [h.orb, h.other])
    // Long enough to feel: many phones' motors don't answer pulses much under 20 ms. (The knocks are felt where the
    // visitor asks for less motion too: they aren't motion on the screen.)
    const ms = Math.round((h.kind === 'marble' ? 24 : 18) + 42 * h.strength)
    for (const id of [h.orb, h.other]) {
      if (!id) continue
      if (id === 'me') { if (tiltOn() && coarse) navigator.vibrate?.(ms); continue }
      const ph = phones.get(id)
      const now = performance.now()
      if (!ph || ph.gone || now - ph.buzzAt < BUZZ_GAP) continue
      ph.buzzAt = now
      remote?.rumble(0.45 + 0.55 * h.strength, 0, ms, id)
    }
  }

  // ---- the opening: drop in, hop along the headline a word at a time, rest on the full stop ----

  function opening() {
    if (!field || still || local.any) return
    const stops = field.tour()
    if (!stops.length) return
    const o = me()
    const first = stops[0]
    // Dropped in over the first word with the rest of the route to hop; on the full stop, left to settle.
    Object.assign(o.orb, { x: first.x, z: first.z, y: DROP, vx: 0, vy: 0, vz: 0, target: null, route: stops.slice(1), flying: false, toss: null, resting: false })
    tour = true
    wake()
  }

  // ---- the loop ----

  // How finely the field draws (./governor.ts): the finest the device keeps up with, judged on the frames while
  // something moves. It starts at the screen's own pixels and goes finer where the GPU shows it has room (so a slow
  // GPU's first second isn't a stutter). ?quality=super|native|lite|plain|low (or a step's number) holds it at one
  // step, for screenshots and for trying a device's steps by hand.
  let steps = ladder(devicePixelRatio || 1, coarse)
  let governor = new Governor(steps, { level: pick(steps, 'native') })
  let pinned = pinnedStep(steps)
  function setQuality() {
    if (!field) return
    const level = pinned ?? governor.level
    field.quality(steps[level], level)
  }
  function pace(dt: number) {
    if (!field || pinned !== null) return
    const before = governor.level
    if (governor.frame(dt, field.gpu()) !== before) setQuality()
  }
  /**
   * The screen changed (the canvas's size, or its pixels per CSS pixel): a ladder for it (the steps above the screen's
   * own pixels within their budget), and the governor starts learning it again.
   */
  function rescale() {
    const dpr = devicePixelRatio || 1
    const next = ladder(dpr, coarse, { w: W, h: H })
    if (JSON.stringify(next) !== JSON.stringify(steps)) {
      // The same kind of step on the new ladder (as fine as before, or the nearest coarser).
      const was = steps[governor.level]
      steps = next
      const at = steps.findIndex((s) => s.pr <= was.pr && s.glass <= was.glass)
      governor = new Governor(steps, { level: at < 0 ? steps.length - 1 : at })
      pinned = pinnedStep(steps)
    } else governor.reset()
    setQuality()
  }

  addActor((now, dt) => {
    if (!visible || !field) return false
    readPhones(now)
    const f = field
    const o = me()
    const mine = now - local.at < HOLD_MS
    const tilting = !!tiltPush && now - tiltAt < HOLD_MS
    if (tour && !o.orb.route.length && !o.orb.flying && o.orb.resting) { tour = false; recentre() }
    if (!tour) o.orb.target = !mine ? null : anchor ? { x: anchor.x, z: anchor.z } : f.pointAt(local.x, local.y)
    if (mine) o.orb.resting = false
    o.live = mine || tilting || now - tossAt < HOLD_MS
    o.push = tilting ? tiltPush : null
    if (tilting) o.orb.resting = false
    for (const [id, ph] of phones) if (ph.gone) { f.removeOrb(id); phones.delete(id) }
    f.pads(measurePads())
    // The buttons are drawn as blocks as deep as their step looks from here.
    const depth = Math.round(f.padDepth() * 2) / 2
    if (depth !== padDepth) { padDepth = depth; hero.style.setProperty('--pad-depth', `${depth}px`) }
    const busy = f.step(dt)
    const padsBusy = answerPads(dt)
    f.render()
    if (busy) pace(dt)
    return busy || padsBusy || mine || tilting || tour
  })

  // Only on screen does anything draw (and three.js loads only then).
  let loading = false
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting
    if (visible) { void load(); wake() }
  }).observe(hero)

  async function load() {
    if (field || loading) return
    loading = true
    try {
      const { createField } = await import('./field')
      // The headline's own font first, so the 3D letters are laid out the way the page wraps them.
      const f = getComputedStyle(title)
      await Promise.race([
        Promise.all([document.fonts?.ready, document.fonts?.load(`${f.fontStyle} ${f.fontWeight} ${f.fontSize} ${f.fontFamily}`).catch(() => undefined)]),
        new Promise((r) => setTimeout(r, 2500)),
      ])
      field = createField(stage, { coarse, still })
      field.onHit = onHit
      field.onQuiet = (q) => glass.note(q.kind, q.speed, q.why)
      setQuality()
      document.documentElement.classList.add('field3d')
      layout()
      // At rest on the full stop, unless the opening is about to bring it there.
      const letters = field.letters()
      const dot = letters[letters.length - 1]
      const o = me()
      if (dot) Object.assign(o.orb, { x: dot.spot[0], z: dot.spot[1], y: TOP + R, resting: true })
      field.render()
      opening()
      new ResizeObserver(() => { layout(); wake() }).observe(hero)
      // The canvas's size in device pixels, exactly, where the browser says (moving to another screen changes it too).
      const exact = new ResizeObserver(([e]) => {
        const d = e.devicePixelContentBoxSize?.[0]
        if (!d || !field) return
        field.pixels(d.inlineSize, d.blockSize)
        rescale()
        field.render()
        wake()
      })
      try { exact.observe(stage, { box: 'device-pixel-content-box' }) } catch { /* Safari: worked out from the CSS size */ }
      // Now there's something to hear.
      heroApi.onSound?.(glass.state)
      wake()
    } catch (e) {
      // No WebGL (or it failed): the headline stays the page's own text.
      console.warn('[ob.Pal] the 3D hero is off:', e)
      document.documentElement.classList.remove('field3d')
      field = null
    }
  }

  const heroApi: Hero = {
    onSound: null,
    attach(r, P) {
      remote = r
      Pointer = P
      r.on('join', join)
      r.on('leave', (p) => { const ph = phones.get(p.id); if (ph) ph.gone = true; pointers.delete(p.id); colors.delete(p.id); wake() })
      r.on('recenter', (p) => pointers.get(p.id)?.recenter())
      r.on('input', () => wake())
      r.on('toss', (e, who) => phoneToss(who, tossSpeed(e.v)))
      // A, or a tap on the trackpad, tosses too (a phone that can't feel a flick, or a person who'd rather press).
      r.on('button', (e, who) => { if ((e.id === 'wii-a' && e.ev === 'down') || (e.id === 'pad' && e.ev === 'tap')) phoneToss(who, A_TOSS) })
      // A colour picked on the phone becomes its marble's, and its seat's, so the phone wears it too.
      r.on('value', (e, who) => {
        if (e.id !== 'accent' || typeof e.v !== 'string') return
        const a = family.ACCENTS.find((x) => x.id === e.v)
        const color = a?.color ?? LIME
        colors.set(who.id, color)
        field?.recolor(who.id, color)
        r.setValues({ color }, who.id)
        wake()
      })
    },
    // From a tap: motion (iOS asks). The same tap has already started the sound.
    tilt: () => startTilt(),
    get tilting() { return tiltOn() },
    get sound() { return glass.state },
    toggleSound: () => glass.toggle(),
    audio: () => glass.stats(),
    tips: () => {
      if (!field) return []
      const f = field
      return f.orbs().map((o) => {
        const p = f.project(o.orb.x, o.orb.y, o.orb.z)
        const s = f.surface(o.orb.x, o.orb.z)
        // What it's on: a letter, a button (1000 + its number: pads()), the floor (-1), or nothing yet (in the air, -2);
        // held: sitting on the rim of a letter's counter.
        const on = Math.abs(o.orb.y - o.orb.r - s.h) < 0.01 && Math.abs(o.orb.vy) < 0.5 ? s.id : -2
        return { id: o.id, x: p.x, y: p.y, life: o.life, h: o.orb.y - o.orb.r, on, held: !!o.orb.held }
      })
    },
    pads: () => padEls.map((el) => el.textContent?.trim() ?? ''),
    outline: (id) => {
      const o = field?.outline(id)
      if (!o) return null
      const a = playArea()
      return { ...o, area: { left: 0, right: W, top: a.top, bottom: a.bottom } }
    },
    dot: () => {
      if (!field) return null
      const l = field.letters()
      const d = l[l.length - 1]
      return d ? field.project(d.spot[0], TOP + R, d.spot[1]) : null
    },
    gfx: () => field && { ...field.gfx(), level: pinned ?? governor.level, steps, pinned: pinned !== null },
  }
  return heroApi
}
