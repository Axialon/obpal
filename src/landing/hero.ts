/**
 * The home page's hero is a bounce field (./field.ts, ./bounce.ts): the headline's letters stand as 3D blocks, seen
 * from overhead, and a glowing orb bounces on them. The mouse, a tap, or the phone's own tilt (a marble on a tray)
 * steers the lime orb; on a computer, phones that scan the code each get an orb in their own colour, steered by
 * their own sensors like the viewer's Wii-style pointer. With nobody steering, the orb drops in, hops along the
 * headline a word at a time and comes to rest on its full stop. Every letter an orb lands on lights up; light them
 * all and the headline celebrates.
 *
 * three.js loads only once the hero is on screen. Until then, and where WebGL isn't available, the headline is the
 * page's own text. Nothing draws while nothing moves.
 */
import { addActor, wake } from './ticker'
import { onTilt, recentre, startTilt, tiltOn } from './tilt'
import type { Participant, Remote } from '@obpal/host'
import type { ScreenPointer } from '../viewer/pointer'
import type { Field } from './field'
import { tourStops } from './letters'

const LIME = '#c6ff34'
/** A hand that stops moving keeps its orb bouncing this long; then the orb settles where it is. */
const HOLD_MS = 2600
/** A phone's orb settles after this long without moving. */
const PHONE_REST_MS = 6000
/** A tilt of this many degrees pushes the orb this hard (em/s² per degree): a marble on a tray. */
const TILT_PUSH = 0.55
/** The opening: the orb falls in from this high (em) and hops a word at a time. */
const DROP = 2.4
/** A letter's top and the orb's radius (field.ts TOP and ORB_R, repeated so the page's first script needn't load three.js). */
const TOP = 0.182
const R = 0.2

export interface Hero {
  /** Phones join through this remote (a computer's pairing card), each with its own orb. */
  attach(remote: Remote, pointer: typeof ScreenPointer): void
  /** Start following the phone's tilt (on a phone; iOS asks first, from a tap). */
  tilt(): Promise<boolean>
  readonly tilting: boolean
  /** Where each orb is on screen, and how lit (for tests). */
  tips(): { id: string; x: number; y: number; life: number }[]
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
  let tiltPush: [number, number] | null = null
  let tiltAt = -1e9
  /** The opening is playing (the marble's route runs it; this is whether it's still going). */
  let tour = false

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

  // ---- your own hand: the mouse, a tap, the phone's tilt ----

  const steer = (x: number, y: number) => {
    local.x = x; local.y = y; local.at = performance.now(); local.any = true
    if (tour && field) { const o = me().orb; o.route = []; o.flying = false }
    tour = false
    opts.onInput?.()
    wake()
  }
  const at = (e: PointerEvent) => { const r = hero.getBoundingClientRect(); steer(e.clientX - r.left, e.clientY - r.top) }
  /** Pressing a button or a link is that, not playing. */
  const onControl = (e: Event) => !!(e.target as Element | null)?.closest?.('a, button')
  // A mouse steers as it moves. A finger only when it taps: touching to scroll leaves the orb be.
  let press: { x: number; y: number; t: number } | null = null
  hero.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') at(e) }, { passive: true })
  hero.addEventListener('pointerdown', (e) => { if (onControl(e)) return; if (e.pointerType === 'mouse') at(e); else press = { x: e.clientX, y: e.clientY, t: e.timeStamp } }, { passive: true })
  hero.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse' && !onControl(e) && press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10 && e.timeStamp - press.t < 350) at(e)
    press = null
  }, { passive: true })
  hero.addEventListener('pointercancel', () => { press = null }, { passive: true })

  // The phone's tilt (once it's on) rolls the lime orb like a marble on a tray, once the opening has finished.
  onTilt((t) => {
    if (!visible || tour) return
    tiltPush = [t.x * TILT_PUSH, t.y * TILT_PUSH]
    if (t.wake) { tiltAt = performance.now(); local.any = true; opts.onInput?.(); wake() }
  })

  // ---- phones on a computer: one orb each, from its Wii-style pointer ----

  let remote: Remote | null = null
  let Pointer: typeof ScreenPointer | null = null
  const pointers = new Map<string, ScreenPointer>()
  const phones = new Map<string, { at: number; gone: boolean }>()
  function join(p: Participant) {
    phones.set(p.id, { at: performance.now(), gone: false })
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
      if (Math.abs(st.dx) + Math.abs(st.dy) > 0.25) ph.at = now
      const o = field.orb(p.id, p.color)
      o.orb.target = field.floorAt(Math.max(0, Math.min(W, st.x)), Math.max(0, Math.min(H, st.y)))
      o.orb.active = now - ph.at < PHONE_REST_MS
      if (o.orb.active) o.orb.resting = false
    }
  }

  // ---- the opening: drop in, hop along the headline a word at a time, rest on the full stop ----

  function opening() {
    if (!field || still || local.any) return
    // One letter from the middle of each word, then the full stop.
    const stops = tourStops(field.letters())
    if (!stops.length) return
    const o = me()
    const first = stops[0]
    // Dropped in over the first word with the rest of the route to hop; on the full stop, left to settle.
    Object.assign(o.orb, { x: first.x, z: first.z, y: DROP, vx: 0, vy: 0, vz: 0, target: null, route: stops.slice(1), flying: false, active: false, resting: false })
    tour = true
    wake()
  }

  // ---- the loop ----

  addActor((now, dt) => {
    if (!visible || !field) return false
    readPhones(now)
    const f = field
    const o = me()
    const mine = now - local.at < HOLD_MS
    const tilting = !!tiltPush && now - tiltAt < HOLD_MS
    if (tour && !o.orb.route.length && !o.orb.flying && o.orb.resting) { tour = false; recentre() }
    if (mine) {
      o.orb.target = f.floorAt(local.x, local.y)
      o.orb.active = true
      o.orb.resting = false
    } else if (!tour) {
      o.orb.target = null
      o.orb.active = tilting
    }
    o.push = tilting ? tiltPush : null
    if (tilting) o.orb.resting = false
    for (const [id, ph] of phones) if (ph.gone) { f.removeOrb(id); phones.delete(id) }
    const busy = f.step(dt)
    f.render()
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

  return {
    attach(r, P) {
      remote = r
      Pointer = P
      r.on('join', join)
      r.on('leave', (p) => { const ph = phones.get(p.id); if (ph) ph.gone = true; pointers.delete(p.id); wake() })
      r.on('recenter', (p) => pointers.get(p.id)?.recenter())
      r.on('input', () => wake())
    },
    tilt: startTilt,
    get tilting() { return tiltOn() },
    tips: () => {
      if (!field) return []
      const f = field
      return f.orbs().map((o) => { const p = f.project(o.orb.x, o.orb.y, o.orb.z); return { id: o.id, x: p.x, y: p.y, life: o.life } })
    },
    dot: () => {
      if (!field) return null
      const l = field.letters()
      const d = l[l.length - 1]
      return d ? field.project(d.spot[0], TOP + R, d.spot[1]) : null
    },
  }
}
