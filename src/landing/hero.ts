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
 * Playing with a phone is the experience: the marbles sound like glass (./glass.ts), and the phone in hand feels
 * every knock its marble takes.
 *
 * three.js loads only once the hero is on screen. Until then, and where WebGL isn't available, the headline is the
 * page's own text. Nothing draws while nothing moves.
 */
import { addActor, wake } from './ticker'
import { onTilt, onToss, recentre, startTilt, tiltOn } from './tilt'
import { hopTo } from './bounce'
import { createGlass } from './glass'
import type { Participant, Remote } from '@obpal/host'
import type { ScreenPointer } from '../viewer/pointer'
import type { Field, Hit } from './field'

const LIME = '#c6ff34'
/** A hand that stops moving keeps steering its marble this long; then the marble rolls to a stop. */
const HOLD_MS = 2600
/** A phone's marble stops following it after this long without moving. */
const PHONE_REST_MS = 6000
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
/** A letter's top and the marble's radius (field.ts TOP and ORB_R, repeated so the page's first script needn't load three.js). */
const TOP = 0.182
const R = 0.2
/** A phone feels at most one knock this often (ms). */
const BUZZ_GAP = 70

export interface Hero {
  /** Phones join through this remote (a computer's pairing card), each with its own marble. */
  attach(remote: Remote, pointer: typeof ScreenPointer): void
  /** Start following the phone's tilt and tosses (on a phone; iOS asks first, from a tap), with sound. */
  tilt(): Promise<boolean>
  readonly tilting: boolean
  /** Sound on or off (on needs a click or a tap, or one earlier on the page). Resolves whether it's on. */
  sound(on: boolean): Promise<boolean>
  readonly soundOn: boolean
  /** Called when playing with a phone starts (sound and feel come with it) or stops. */
  onExperience: ((on: boolean) => void) | null
  /** Where each marble is on screen, how lit, how high it is (em, above the floor) and what it's on (for tests). */
  tips(): { id: string; x: number; y: number; life: number; h: number; on: number }[]
  /** Where the full stop's landing spot is on screen (for tests), once the field is up. */
  dot(): { x: number; y: number } | null
}

export function mountHero(hero: HTMLElement, stage: HTMLCanvasElement, title: HTMLElement, opts: { still: boolean; onInput?: () => void }): Hero {
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
  const glass = createGlass()
  let experience = false

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
    field.layout(m.lines, W, H, m.box)
    field.render()
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
  const phones = new Map<string, { at: number; gone: boolean; buzzAt: number }>()
  function join(p: Participant) {
    phones.set(p.id, { at: performance.now(), gone: false, buzzAt: 0 })
    if (!pointers.has(p.id)) pointers.set(p.id, new Pointer!())
    setExperience()
    wake()
  }
  function readPhones(now: number) {
    if (!remote || !field) return
    for (const p of remote.participants) {
      if (!phones.has(p.id) || phones.get(p.id)!.gone) join(p)
      const ph = phones.get(p.id)!
      const f = remote.consumeOf(p.id, now)
      const st = pointers.get(p.id)!.step(f.aim, f.pad1, W, H)
      if (Math.abs(st.dx) + Math.abs(st.dy) > 0.25) ph.at = now
      const o = field.orb(p.id, p.color)
      o.live = now - ph.at < PHONE_REST_MS
      o.orb.target = o.live ? field.pointAt(Math.max(0, Math.min(W, st.x)), Math.max(0, Math.min(H, st.y))) : null
      if (o.live) o.orb.resting = false
    }
  }
  function phoneToss(who: Participant, vy: number) {
    if (!field || !visible) return
    const ph = phones.get(who.id)
    if (ph) ph.at = performance.now()
    field.toss(field.orb(who.id, who.color), vy)
    wake()
  }

  // ---- the experience: sound, and the knocks felt in the hand ----

  function setExperience() {
    const on = (remote?.participants.length ?? 0) > 0 || tiltOn()
    if (on === experience) return
    experience = on
    // Sound comes with it where the page may already make it (someone clicked here before) and wasn't switched off.
    const active = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive
    if (on && active && !glass.muted) void glass.set(true).then(() => heroApi.onExperience?.(true))
    else heroApi.onExperience?.(on)
  }

  function onHit(h: Hit) {
    if (!field) return
    const p = field.project(h.x, h.y, h.z)
    glass.hit(h.kind, h.strength, (p.x / Math.max(1, W)) * 2 - 1)
    const ms = Math.round((h.kind === 'marble' ? 10 : 8) + 22 * h.strength)
    for (const id of [h.orb, h.other]) {
      if (!id) continue
      if (id === 'me') { if (tiltOn() && coarse) navigator.vibrate?.(ms); continue }
      const ph = phones.get(id)
      const now = performance.now()
      if (!ph || ph.gone || now - ph.buzzAt < BUZZ_GAP) continue
      ph.buzzAt = now
      remote?.rumble(Math.max(0.35, h.strength), 0, ms, id)
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

  // A device that can't keep up draws less finely: judged on the frames while something moves.
  const frames: number[] = []
  let quality = 2
  function pace(dt: number) {
    if (!field || quality === 0) return
    frames.push(dt)
    if (frames.length < 90) return
    const slow = frames.sort((a, b) => a - b)[45] > 1 / 40
    frames.length = 0
    if (slow) field.quality(--quality)
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
    const busy = f.step(dt)
    f.render()
    if (busy) pace(dt)
    return busy || mine || tilting || tour
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
      field = createField(stage, { coarse })
      field.onHit = onHit
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
      wake()
    } catch (e) {
      // No WebGL (or it failed): the headline stays the page's own text.
      console.warn('[ob.Pal] the 3D hero is off:', e)
      document.documentElement.classList.remove('field3d')
      field = null
    }
  }

  const heroApi: Hero = {
    onExperience: null,
    attach(r, P) {
      remote = r
      Pointer = P
      r.on('join', join)
      r.on('leave', (p) => { const ph = phones.get(p.id); if (ph) ph.gone = true; pointers.delete(p.id); setExperience(); wake() })
      r.on('recenter', (p) => pointers.get(p.id)?.recenter())
      r.on('input', () => wake())
      r.on('toss', (e, who) => phoneToss(who, tossSpeed(e.v)))
      // A on the phone tosses too (phones that can't feel a flick, or a person who'd rather press).
      r.on('button', (e, who) => { if (e.id === 'wii-a' && e.ev === 'down') phoneToss(who, A_TOSS) })
    },
    async tilt() {
      // From the same tap: motion (iOS asks), and sound.
      const sound = glass.muted ? Promise.resolve(false) : glass.set(true)
      const ok = await startTilt()
      await sound
      setExperience()
      return ok
    },
    get tilting() { return tiltOn() },
    sound: (on) => glass.set(on),
    get soundOn() { return glass.on },
    tips: () => {
      if (!field) return []
      const f = field
      return f.orbs().map((o) => {
        const p = f.project(o.orb.x, o.orb.y, o.orb.z)
        const under = f.under(o.orb.x, o.orb.z)
        // What it's on: a letter, the floor (-1), or nothing yet (in the air, -2).
        const on = Math.abs(o.orb.y - o.orb.r - (under >= 0 ? TOP : 0)) < 0.01 && Math.abs(o.orb.vy) < 0.5 ? under : -2
        return { id: o.id, x: p.x, y: p.y, life: o.life, h: o.orb.y - o.orb.r, on }
      })
    },
    dot: () => {
      if (!field) return null
      const l = field.letters()
      const d = l[l.length - 1]
      return d ? field.project(d.spot[0], TOP + R, d.spot[1]) : null
    },
  }
  return heroApi
}
