/**
 * A viewport marble field for the whole home page. Layout observers cache static document-space obstacles; active
 * transforms are read together before drawing, and scrolling sweeps their motion through the marbles. The shared
 * ticker advances fixed-step physics and interpolates drawing.
 * Pointer events never capture, cancel navigation or prevent text selection. Reduced motion skips the opening;
 * marbles rest until explicitly played with. The saved field switch stops drawing and restores the text headline.
 * On a phone the field plays only in the hero while PHONE_FIELD_SCOPE is 'hero' (./scope.ts): the canvas scrolls away
 * with the hero and the field sleeps once the hero is out of view.
 */
import { addActor, addRead, wake } from './ticker'
import { onTilt, onToss, recentre, startTilt, tiltOn } from './tilt'
import { hopTo } from './bounce'
import { createGlass, type GlassStats, type SoundState } from './glass'
import { Governor, ladder, pick, type Step } from './governor'
import type { Frame, Participant, Remote } from '@obpal/host'
import type { ScreenPointer } from '../viewer/pointer'
import type { Field, FieldOrb, Gfx, Hit, PadRect } from './field'
import { family } from '../family'
import { html, setMarkup } from '../ui/markup'
import { fieldScope, heroInView, stageTop } from './scope'

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
/**
 * The page's raised things in the hero that marbles roll onto (its buttons, the hint, the sound control, the three
 * steps' icons). Their footprints stay fixed between layout observations.
 */
const PADS = '.cta .btn, [data-hint], .quick .qi'

/** The step ?quality= holds the field at, if any. */
function pinnedStep(steps: readonly Step[]): number | null {
  const q = new URLSearchParams(location.search).get('quality')
  const at = q === null ? -1 : pick(steps, q)
  return at < 0 ? null : at
}

export interface Hero {
  /** Cached geometry and physical state for the deterministic whole-page contact proof. */
  contacts(): { rects: { id: number; owner: string; rect: PadRect }[]; marbles: { id: string; speed: number; resting: boolean }[] }
  seed(id: string, x: number, y: number): void
  showSeeds(): void
  clearSeeds(): void
  /** Phones join through this remote (a computer's pairing card), each with its own marble. */
  attach(remote: Remote, pointer: typeof ScreenPointer, read?: (who: string, now: number) => Frame): void
  /** Start following the phone's tilt and tosses (on a phone; iOS asks first, from a tap). */
  tilt(): Promise<boolean>
  readonly tilting: boolean
  readonly enabled: boolean
  toggleField(): void
  activity(): { draws: number; layouts: number; active: number; enabled: boolean; moving: number; reads: number; motionMs: number; stepMs: number; renderMs: number; scroll: number }
  /** A card being directly played takes the motion budget until it settles. */
  sceneActive(active: boolean): boolean
  /** The marbles' sound (./glass.ts): on, blocked (waiting for a click or a tap), off, or none. */
  readonly sound: SoundState
  /** The sound button was pressed (a click: the sound can start right there). */
  toggleSound(): void
  /** Called when the sound's state changes, and once the field is up (before it, there's nothing to hear). */
  onSound: ((s: SoundState) => void) | null
  /** The sound's state, hits and output level (the ?debug=audio readout, tests). */
  audio(): GlassStats
  /** Where each marble is on screen, how lit, how high it is (em, above the floor) and what it's on (for tests). */
  tips(): { id: string; x: number; y: number; vx: number; vy: number; ring: boolean; life: number; h: number; on: number; held: boolean; airborne: boolean; phase: string; age: number; drop: boolean; radius: number; free: boolean }[]
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
  /** Drop the lime marble in from a little above the letters' tops, over a point on the hero (hero px; tests). */
  drop(x: number, y: number): void
  /** Start a grounded roll in viewport pixels, with a pixel-per-second velocity (tests). */
  roll(x: number, y: number, vx: number, vy: number): void
  /** Where each letter's counters are on the hero (hero px: the deepest point of each, on the letters' tops; tests). */
  counters(): { letter: number; x: number; y: number }[]
  /** The gaps between two letters narrower than a marble, where each is narrowest (hero px, on the letters' tops; tests). */
  gaps(): { a: number; b: number; x: number; y: number }[]
  /**
   * Each raised thing as a block (tests): its words, how tall it stands (em), its side as the field sees it (px, from
   * its top's near edge down to the floor; null: not there), and as it's drawn (its --pad-dx, --pad-dy).
   */
  steps(): { text: string; height: number; side: { dx: number; dy: number } | null; drawn: { dx: number; dy: number } }[]
  /**
   * The marbles' own clock (s: their physics' fixed steps so far) and whether the hero's loop is running (something
   * moves, or someone steers): tests wait on it rather than the wall clock, which a busy machine outpaces.
   */
  sim(): { t: number; busy: boolean }
}

export function mountHero(hero: HTMLElement, stage: HTMLCanvasElement, title: HTMLElement, opts: { still: boolean; onInput?: () => void; meter?: boolean; phone?: boolean }): Hero {
  const still = opts.still
  const coarse = matchMedia('(pointer: coarse)').matches
  /**
   * On a phone showing only the hero's field: the canvas is laid at the top of the page (home.css) and scrolls away
   * with it, so the page's scroll never reaches the field (no ride, lift, land or dock), the lower sections' cards
   * and headings aren't colliders, and the field sleeps while the hero is out of view.
   */
  const scoped = fieldScope(!!opts.phone, location.search) === 'hero'
  document.documentElement.classList.toggle('field-hero', scoped)
  let field: Field | null = null
  /** Whether the field plays: always, but while a scoped field's hero is scrolled out of view. */
  let visible = !scoped || scrollY < innerHeight
  let enabled = true
  try { enabled = localStorage.getItem('obpal-home-field') !== 'off' } catch { /* Storage can be unavailable. */ }
  let draws = 0, layouts = 0, dirty = true
  let pageGeometry: typeof import('./obstacles') | null = null
  let viewportTop = 0, pendingScroll = scrollY, appliedScroll = 0
  let sceneUnderPointer = false
  let sceneBusy = false
  let sceneDrawAt = -1e9
  let lastInteraction = performance.now()
  let scrollAt = -1e9
  stage.parentElement?.removeChild(stage)
  document.body.appendChild(stage)
  const fieldToggle = document.createElement('button')
  fieldToggle.type = 'button'
  fieldToggle.className = 'hero-sound field-toggle'
  fieldToggle.dataset.fieldToggle = ''
  const dock = document.createElement('div')
  dock.className = 'field-controls'
  const volume = hero.querySelector<HTMLElement>('[data-sound]')
  document.body.appendChild(dock)
  dock.appendChild(fieldToggle)
  if (volume) dock.appendChild(volume)
  setMarkup(fieldToggle, html`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M7.5 9a5 5 0 0 1 7-2M6.5 14c3.5-3 6 4 11-1"/><path class="when-off" d="m4 4 16 16"/></svg>`)
  const preference = () => {
    fieldToggle.dataset.state = enabled ? 'on' : 'off'
    fieldToggle.setAttribute('aria-label', enabled ? 'Marbles on' : 'Marbles off')
    fieldToggle.title = enabled ? 'Marbles on — turn off' : 'Marbles off — turn on'
    fieldToggle.setAttribute('aria-pressed', String(enabled))
    stage.hidden = !enabled
    document.documentElement.classList.toggle('field3d', enabled && !!field)
  }
  preference()
  fieldToggle.addEventListener('click', () => {
    if (field?.release()) { local.at = -1e9; anchor = null; tour = false; dirty = true; wake(); return }
    heroApi.toggleField()
  })
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
  // browsing, or following a link: starting sound there could pause the person's own music). The sound button, and the
  // quick-actions tray's sound switch (../ui/quick.ts), decide for themselves.
  const unlock = (e: Event) => {
    const t = e.target as Element | null
    if (t?.closest?.('[data-sound], [data-quick="sound"]')) return
    if (coarse && (!t || !hero.contains(t) || t.closest('a, [data-send], [data-scan]'))) return
    glass.gesture()
  }
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click']) addEventListener(type, unlock, { capture: true, passive: true })

  /** The headline as the page wraps it: its lines of text, and the box its letters fill (hero px). */
  function measure() {
    // The fixed canvas starts at the viewport origin (a scoped one, at the page's). Its measured CSS box is the shared
    // frame for DOM rects, physics and projection; innerWidth includes a classic scrollbar that the canvas's 100% width
    // excludes.
    // Keep fractional CSS pixels here. Only the renderer rounds when choosing its DPR-scaled backing buffer.
    const viewport = stage.getBoundingClientRect()
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
    const box = { x: 0, y: 0, w: viewport.width, h: viewport.height }
    if (rects.length) {
      box.x = Math.min(...rects.map((q) => q.left))
      box.y = Math.min(...rects.map((q) => q.top)) + scrollY
      box.w = Math.max(...rects.map((q) => q.right)) - box.x
      box.h = Math.max(...rects.map((q) => q.bottom)) + scrollY - box.y
    }
    return { lines: lines.length ? lines : [title.textContent ?? ''], box, W: viewport.width, H: viewport.height }
  }

  /** A scoped field's layout was due while the hero was out of view: made when it returns. */
  let layoutDue = false
  function layout(includePage = true) {
    if (!field) return
    if (scoped && !visible) { layoutDue = true; return }
    layouts++
    viewportTop = document.querySelector<HTMLElement>('header.top')?.offsetHeight ?? 0
    const m = measure()
    W = m.W; H = m.H
    // The ladder for this size first, so the canvas is never drawn past its pixel budget, not even for a frame.
    rescale()
    field.layout(m.lines, W, H, m.box)
    const play = playArea()
    field.play(play.top, play.bottom)
    field.pads(measurePads(includePage))
    const peg = fieldToggle.getBoundingClientRect()
    field.dock({ x: peg.left + peg.width / 2, y: (scoped ? stageTop(peg.top, scrollY, H) : peg.top) + peg.height / 2 })
    drawSides(field)
    // A scoped field never scrolls: its canvas does.
    if (!scoped) { field.scroll(pendingScroll, false); appliedScroll = pendingScroll }
    scope()
    if (repelledCard) repelDemo(repelledCard)
    dirty = true
    wake()
  }

  /**
   * What of the hero the marbles may use: what's on screen with the page at its top. Below the page's bar where it
   * covers the hero's top (a marble under it would be hidden), down to the bottom of the screen with the browser's own
   * bars showing (100svh), or the hero's bottom if that comes first. (On a phone the hero is taller than the screen.)
   */
  function playArea() { return { top: viewportTop, bottom: H } }

  const me = () => field!.orb('me', family.accentColor())
  const palette = () => {
    if (!field) return
    const root = document.documentElement, css = getComputedStyle(root)
    const carbon = root.dataset.bbTheme === 'carbon', light = root.dataset.bbTheme === 'light'
    field.palette(carbon ? '#f1edff' : css.getPropertyValue('--bb-ink').trim(),
      light ? css.getPropertyValue('--bb-accent-text').trim() : family.accentColor(),
      carbon ? '#5c3ef5' : css.getPropertyValue('--bb-ink-2').trim())
    field.recolor('me', family.accentColor())
    dirty = true
    wake()
  }
  addEventListener('bb-theme', palette)
  addEventListener('bb-accent', palette)
  /** The player takes over from the opening. */
  function takeOver() {
    if (tour && field) { const o = me().orb; o.route = []; o.flying = false; o.aim = null }
    tour = false
    local.any = true
    lastInteraction = performance.now()
    dirty = true
    opts.onInput?.()
  }

  // ---- your own hand: the mouse, a tap, the phone's tilt and tosses ----

  /** Where a pointer is on the field: its canvas scrolls with the page when scoped, so the page's scroll is added. */
  const heroAt = (e: PointerEvent) => ({ x: e.clientX, y: e.clientY + (scoped ? scrollY : 0) })
  /** Pressing a button or a link is that, not playing. */
  const onControl = (e: Event) => !!(e.target as Element | null)?.closest?.('a, button, input, textarea, select, [contenteditable], .scene-art')
  // The mouse rolls the marble after it; a click (or a tap) hops it onto the spot. Touching to scroll leaves it be.
  let press: { x: number; y: number; t: number } | null = null
  const follow = (e: PointerEvent) => {
    sceneUnderPointer = !!(e.target as Element | null)?.closest?.('.scene-art')
    if (sceneUnderPointer) { local.at = -1e9; repelDemo(e.target as Element); wake(); return }
    if (e.pointerType !== 'mouse' || !enabled) return
    repelDemo(document.activeElement?.closest('.scene') ?? null)
    const p = heroAt(e)
    local.x = p.x; local.y = p.y; local.at = performance.now()
    if (anchor && Math.hypot(p.x - anchor.sx, p.y - anchor.sy) > 10) anchor = null
    takeOver()
    wake()
  }
  document.addEventListener('pointermove', follow, { passive: true })
  const hop = (e: PointerEvent) => {
    if (!field || !enabled) return
    const p = heroAt(e)
    // Only the canvas plays when scoped: a tap on the sections below it is a tap on them.
    if (scoped && (!visible || p.y > H)) return
    takeOver()
    // Onto the letter clicked (or right by), at its landing spot; it stays there until the mouse moves on.
    const spot = field.spotAt(p.x, p.y)
    hopTo(me().orb, spot)
    anchor = { sx: p.x, sy: p.y, ...spot }
    // A tap has no hover to follow afterwards: the marble stays where it lands.
    if (e.pointerType !== 'mouse') { local.at = -1e9; anchor = null }
    wake()
  }
  document.addEventListener('pointerdown', (e) => {
    if (onControl(e)) return
    if (e.pointerType === 'mouse') { if (e.button === 0) press = { x: e.clientX, y: e.clientY, t: e.timeStamp } } else press = { x: e.clientX, y: e.clientY, t: e.timeStamp }
  }, { passive: true })
  document.addEventListener('pointerup', (e) => {
    if (!onControl(e) && !getSelection()?.toString() && press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10 && e.timeStamp - press.t < 350) hop(e)
    press = null
  }, { passive: true })
  document.addEventListener('pointercancel', () => { press = null }, { passive: true })

  // The phone's tilt (once it's on) rolls the lime marble like a marble on a tray, once the opening has finished;
  // flicking the phone upward tosses it.
  onTilt((t) => {
    if (!visible || tour) return
    tiltPush = [t.x * TILT_PUSH, t.y * TILT_PUSH]
    if (t.wake) { tiltAt = lastInteraction = performance.now(); local.any = true; opts.onInput?.(); wake() }
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
  let read: ((who: string, now: number) => Frame) | undefined
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
      const f = read ? read(p.id, now) : remote.consumeOf(p.id, now)
      const st = pointers.get(p.id)!.step(f.aim, f.pad1, W, H)
      const o = field.orb(p.id, colors.get(p.id) ?? p.color)
      // Held as a tray (Tilt, with its gyro on), the phone's tilt rolls its marble; pointed (Point, or a finger on
      // its trackpad), the marble rolls to where it points.
      const push: [number, number] = f.mode === TILT_MODE ? [f.tilt[0] * PHONE_TILT_PUSH, f.tilt[1] * PHONE_TILT_PUSH] : [0, 0]
      const tilted = Math.hypot(push[0], push[1]) > 0.05
      const pointed = Math.abs(st.dx) + Math.abs(st.dy) > 0.25
      if (tilted || pointed) { ph.at = now; lastInteraction = now }
      if (tilted) ph.pointing = false
      else if (pointed) ph.pointing = true
      o.live = now - ph.at < PHONE_REST_MS
      o.push = tilted ? push : null
      // (Its marble wakes by itself when that moves it: ./bounce.ts.)
      o.orb.target = o.live && ph.pointing ? field.pointAt(Math.max(0, Math.min(W, st.x)), Math.max(0, Math.min(H, st.y))) : null
    }
  }
  function phoneToss(who: Participant, vy: number) {
    if (!field || !visible) return
    lastInteraction = performance.now()
    const ph = phones.get(who.id)
    if (ph) ph.at = performance.now()
    field.toss(field.orb(who.id, colors.get(who.id) ?? who.color), vy)
    wake()
  }

  // ---- the page's buttons: steps the marbles roll up onto and off (./field.ts), which answer them ----

  // Hero blocks answer a marble with light, never movement or a synthetic click.
  const padEls = [...hero.querySelectorAll<HTMLElement>(PADS), ...(volume ? [volume] : []), fieldToggle]
  const padState = new Map(padEls.map((el) => [el, { glow: 0, flash: 0, shown: '' }]))
  /** Each button's box (hero px), in the order the field counts them; empty while one isn't there to stand on. */
  let padRects: PadRect[] = []
  let padOwners: (HTMLElement | null)[] = []
  let headings: { el: HTMLElement; box: PadRect; lines: PadRect[] | null }[] = []
  const onscreen = new Set<Element>(), moving = new Set<Element>()
  const settling = new Set<Element>()
  let motionRects: { index: number; rect: PadRect }[] = []
  let geometryReads = 0, motionMs = 0, stepMs = 0
  const motionWatch = new IntersectionObserver(entries => {
    for (const e of entries) { if (e.isIntersecting) onscreen.add(e.target); else onscreen.delete(e.target) }
  }, { rootMargin: '50px' })
  const motionTargets = '.scene, .build-card, .pair, .hero-hint, main a, main button, .field-controls button'
  for (const el of document.querySelectorAll(motionTargets)) motionWatch.observe(el)
  const motionStart = (e: Event) => {
    if (e instanceof TransitionEvent && e.propertyName !== 'transform') return
    const el = e.target as Element
    if (el.matches(motionTargets)) { settling.delete(el); moving.add(el); wake() }
  }
  const motionEnd = (e: Event) => {
    if (e instanceof TransitionEvent && e.propertyName !== 'transform') return
    const el = e.target as Element
    if (moving.has(el)) { settling.add(el); scheduleLayout(); wake() }
  }
  for (const type of ['transitionrun', 'animationstart']) document.addEventListener(type, motionStart)
  for (const type of ['transitionend', 'transitioncancel', 'animationend', 'animationcancel']) document.addEventListener(type, motionEnd)
  addRead(() => {
    const at = performance.now()
    motionRects = []
    geometryReads = 0
    if (!field || !enabled || document.hidden) return
    // Only moving, visible bodies are read. Scroll is analytic; static elements never enter this phase.
    for (const el of moving) {
      if (!onscreen.has(el)) continue
      const index = padOwners.indexOf(el as HTMLElement), base = padRects[index]
      if (!base) continue
      geometryReads++
      motionRects.push({ index, rect: { ...base, ...borderBox(el as HTMLElement) } })
    }
    // End and cancellation can restore a transform instantly. Read that final pose once before caching it again.
    for (const el of settling) moving.delete(el)
    settling.clear()
    motionMs = performance.now() - at
  })
  let repelledCard: Element | null = null
  function repelDemo(target: Element | null) {
    const card = target?.closest('.scene')
    repelledCard = card ?? null
    const i = card ? padOwners.indexOf(card as HTMLElement) : -1
    const rect = i >= 0 ? padRects[i] : null
    field?.avoid(rect ? { ...rect, y: rect.y - appliedScroll } : null)
    dirty = true
  }
  document.addEventListener('focusin', e => { repelDemo(e.target as Element); dirty = true; wake() })
  document.addEventListener('focusout', () => { repelDemo(null); wake() })
  document.addEventListener('pointerdown', e => { if ((e.target as Element)?.closest('.scene-art')) repelDemo(e.target as Element) }, { passive: true })
  let ping: { el: HTMLElement; timer: number } | null = null
  /** Each raised thing's side as last drawn (px, to the half pixel): where its foot is on screen from its top. */
  const padSide = padEls.map(() => '')
  /** Where each fixed control's top is on the screen (px), while the field is scoped: it rides the canvas as it scrolls. */
  const screenTop = new WeakMap<HTMLElement, number>()
  /**
   * The border box after transforms, in CSS pixels. Shadows and focus outlines are light, not solid edges. A control
   * fixed to the screen is placed on the field's own coordinates: the screen's, or (scoped, where the canvas scrolls
   * with the page) the canvas's, which the control leaves as the page scrolls (./scope.ts stageTop()).
   */
  function borderBox(el: HTMLElement): PadRect {
    const r = el.getBoundingClientRect(), css = getComputedStyle(el)
    const fixed = el.closest('.field-controls') !== null
    const value = css.borderTopLeftRadius
    const radius = value.endsWith('%') ? parseFloat(value) / 100 * Math.min(r.width, r.height)
      : (parseFloat(value) || 0) * (el.offsetWidth ? r.width / el.offsetWidth : 1)
    if (fixed && scoped) screenTop.set(el, r.top)
    const y = fixed ? (scoped ? stageTop(r.top, scrollY, H) : r.top) : r.top + scrollY
    return { x: r.left, y, w: r.width, h: r.height, r: Math.min(radius, r.width / 2, r.height / 2), fixed }
  }
  /** A scoped field's fixed controls follow the page's scroll down its canvas (and out of the play area). */
  function followScroll() {
    if (!field || !scoped) return
    const updates: { index: number; rect: PadRect }[] = []
    padEls.forEach((el, index) => {
      const top = screenTop.get(el), base = padRects[index]
      if (top === undefined || !base || base.w <= 0) return
      const y = stageTop(top, scrollY, H)
      if (y !== base.y) updates.push({ index, rect: { ...base, y } })
    })
    if (!updates.length) return
    for (const { index, rect } of updates) padRects[index] = rect
    field.movePads(updates, 1 / 60)
    dirty = true; wake()
  }
  function measurePads(includePage = true): PadRect[] {
    padOwners = [...padEls]
    padRects = padEls.map((el) => {
      if (el.hidden || el.classList.contains('gone') || !el.getClientRects().length) return { x: 0, y: 0, w: 0, h: 0, r: 0 }
      const rect = borderBox(el)
      return rect.fixed ? { ...rect, r: rect.w / 2, height: .22, exclude: true, step: false } : rect
    })
    if (!pageGeometry || !includePage) return padRects
    // Card titles share their solid card's border; the hero retains its drawn, colliding letters.
    for (const el of document.querySelectorAll<HTMLElement>('main .pair, main .scene, main .build-card, main a, main button, main .live-dot')) {
      // A scoped field plays on the hero alone: nothing below it is built as an obstacle.
      if ((scoped && !hero.contains(el)) || (hero.contains(el) && !el.matches('.pair, .live-dot')) || !el.getClientRects().length) continue
      // Content inside a solid card shares its collider; nested controls never make trapping seams.
      if (!el.matches('.pair, .scene, .build-card') && el.closest('.pair, .scene, .build-card')) continue
      const kind = el.matches('.pair, .scene, .build-card') ? 'rail' : el.matches('.live-dot') ? 'peg' : 'block'
      padOwners.push(el)
      padRects.push(pageGeometry.obstacleRect(borderBox(el), kind))
    }
    headings = [...document.querySelectorAll<HTMLElement>('main h2, main .eyebrow, main .sec-head > p')]
      .filter(el => !el.closest('.pair, .scene, .build-card') && el.getClientRects().length && (!scoped || hero.contains(el)))
      .map(el => ({ el, box: borderBox(el), lines: null }))
    prepareHeadingPads(false)
    return padRects
  }
  /** Read the browser's actual text lines only when they approach the viewport; scroll reuses those document boxes. */
  function prepareHeadingPads(apply = true) {
    if (!enabled || document.hidden || !pageGeometry || !headings.length) return
    let changed = false
    for (const heading of headings) {
      if (heading.lines || !pageGeometry.nearViewport(heading.box, pendingScroll, H, 200)) continue
      const range = document.createRange(), lines: PadRect[] = []
      const walker = document.createTreeWalker(heading.el, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const text = walker.currentNode as Text, start = text.data.search(/\S/)
        if (start < 0) continue
        range.setStart(text, start)
        range.setEnd(text, text.data.trimEnd().length)
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue
          const line = lines.find(line => Math.abs(line.y - rect.top - scrollY) < 1 && Math.abs(line.h - rect.height) < 1)
          if (line) {
            const right = Math.max(line.x + line.w, rect.right)
            line.x = Math.min(line.x, rect.left); line.w = right - line.x
          } else lines.push({ x: rect.left, y: rect.top + scrollY, w: rect.width, h: rect.height, r: 0, height: .12, step: false, exclude: true, text: true })
        }
      }
      heading.lines = lines
      for (const line of lines) { padRects.push(line); padOwners.push(heading.el) }
      changed = true
    }
    if (!changed) return
    if (apply) { field?.pads(padRects); dirty = true; wake() }
  }
  function padHit(h: Hit) {
    const owner = h.pad === undefined ? null : padOwners[h.pad]
    if (owner && !padState.has(owner)) {
      if (ping) { clearTimeout(ping.timer); ping.el.classList.remove('field-hit') }
      owner.classList.add('field-hit')
      ping = { el: owner, timer: window.setTimeout(() => { owner.classList.remove('field-hit'); ping = null }, 350) }
    }
    const st = h.pad === undefined ? undefined : padState.get(padEls[h.pad])
    const b = h.pad === undefined ? undefined : padRects[h.pad]
    if (!st || !b || !field) return
    st.flash = Math.max(st.flash, 0.55 + 0.45 * h.strength)
  }
  /**
   * Each raised thing is drawn as a block (home.css): its side as tall as its step looks from here, leaning the way it's
   * seen (./field.ts padSides()), so a marble climbs onto it and rolls off it at the edges drawn.
   */
  function drawSides(f: Field) {
    f.padSides().forEach((d, i) => {
      if (!d || !padEls[i]) return
      const dx = Math.round(d.dx * 2) / 2, dy = Math.round(d.dy * 2) / 2
      const key = `${dx},${dy}`
      if (key === padSide[i]) return
      padSide[i] = key
      padEls[i].style.setProperty('--pad-dx', `${dx}px`)
      padEls[i].style.setProperty('--pad-dy', `${dy}px`)
    })
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
      const cached = padRects[i]
      const b = cached && { ...cached, y: cached.y - (cached.fixed ? 0 : appliedScroll) }
      if (!b) return
      let near: { o: FieldOrb; x: number; y: number; k: number } | null = null
      for (const { o, p, rad, s } of b.w > 0 ? orbs : []) {
        const on = s.id === PAD_ID + i && o.orb.y - o.orb.r - s.h < 0.02
        // How near it is: 1 on it or over it, fading out a few radii away.
        const d = Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.w), Math.max(b.y - p.y, 0, p.y - b.y - b.h))
        const k = on ? 1 : Math.max(0, 1 - d / (rad * 3)) * (0.35 + 0.65 * o.life)
        if (!near || k > near.k) near = { o, x: p.x - b.x, y: p.y - b.y, k }
      }
      const goal = near ? near.k : 0
      st.glow += (goal - st.glow) * (1 - Math.exp(-dt * 10))
      st.flash *= Math.exp(-dt * 5)
      const lit = Math.min(1, Math.max(st.glow, st.flash))
      const c = near?.o.color
      const shown = `${near ? `${near.x.toFixed(0)},${near.y.toFixed(0)}` : ''}|${lit.toFixed(2)}|${c ? c.getHexString() : ''}`
      if (shown !== st.shown) {
        st.shown = shown
        const s = el.style
        if (near) { s.setProperty('--orb-x', `${near.x.toFixed(0)}px`); s.setProperty('--orb-y', `${near.y.toFixed(0)}px`) }
        if (c) s.setProperty('--orb-rgb', `${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)}`)
        s.setProperty('--orb-glow', lit.toFixed(2))
      }
      if (st.flash > 0.01 || Math.abs(st.glow - goal) > 0.01) busy = true
    })
    return busy
  }
  // A button that changes (it goes, it appears, its words change, the words above it reflow) while nothing moves wakes
  // the marbles, which find it where it is now.
  let layoutTimer = 0
  function scheduleLayout() {
    clearTimeout(layoutTimer)
    layoutTimer = window.setTimeout(() => { layoutTimer = 0; if (enabled && !document.hidden) layout() }, 80)
  }
  const padWatch = new MutationObserver(scheduleLayout)
  const padSize = new ResizeObserver(scheduleLayout)
  padSize.observe(stage)
  for (const el of padEls) { padWatch.observe(el, { attributes: true, attributeFilter: ['class', 'hidden', 'data-state'] }); padSize.observe(el) }
  const copy = hero.querySelector('.hero-copy')
  if (copy) padSize.observe(copy)
  for (const el of document.querySelectorAll('main > section, .scene, .build-card, .pair, .site-foot')) padSize.observe(el)
  const sectionWatch = new IntersectionObserver(() => { prepareHeadingPads(); dirty = true; wake() }, { rootMargin: '200px' })
  for (const section of document.querySelectorAll('main > section')) sectionWatch.observe(section)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { glass.foresee([], 0); looping = false }
    else { dirty = true; scheduleLayout(); wake() }
  })
  addEventListener('resize', scheduleLayout, { passive: true })
  visualViewport?.addEventListener('resize', scheduleLayout, { passive: true })
  document.fonts?.addEventListener('loadingdone', scheduleLayout)
  /**
   * A scoped field sleeps while its hero is out of view (no physics, no drawing, nothing heard) and carries on, from
   * where it was, when the hero returns: the marble is a part of the hero, which scrolls with the page.
   */
  function scope() {
    if (!scoped) return
    const now = heroInView(scrollY, H > 1 ? H : innerHeight, viewportTop)
    if (now === visible) return
    visible = now
    if (!now) { tiltPush = null; looping = false; glass.foresee([], 0); return }
    if (!field) { if (enabled) void load(); return }
    // Whatever changed on the page meanwhile (a resize, a font, a card loading) is laid out before the first frame.
    if (layoutDue) { layoutDue = false; layout() }
    dirty = true; wake()
  }
  addEventListener('scroll', () => {
    pendingScroll = scrollY
    // A jump can bypass the observer's margin. Prepare newly visible text before the ticker draws this scroll.
    prepareHeadingPads()
    sceneUnderPointer = false
    if (scoped) { scope(); followScroll(); return }
    lastInteraction = scrollAt = performance.now(); dirty = true; wake()
  }, { passive: true })

  // ---- what a hit sounds like, and the knock felt in the hand ----

  /** The frame being drawn (its rAF time, ms): a hit is heard at the moment within it that it happened. */
  let frameAt = 0
  /** Whether the loop goes on after the last frame (something moves, or someone steers). */
  let looping = false
  let renderWork = 0
  /** Where a hit is heard from: -1 left … 1 right, as it's on screen. */
  const panOf = (f: Field, h: Hit) => (f.project(h.x, h.y, h.z).x / Math.max(1, W)) * 2 - 1
  function onHit(h: Hit) {
    if (!field) return
    if (h.kind === 'button') padHit(h)
    glass.hit(h.kind, h.speed, panOf(field, h), [h.orb, h.other], frameAt - h.ago * 1000, h.key)
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

  /**
   * The knocks coming within the speakers' lag behind the screen, foreseen and started ahead so each is heard the
   * moment it's seen (./glass.ts foresee()), and called off if it stops being foreseen before it starts. ?foresee=off
   * leaves them to be heard as they come (to hear the difference).
   */
  const foresight = new URLSearchParams(location.search).get('foresee') !== 'off'
  function foresee(f: Field, dt: number) {
    const lead = foresight ? glass.lead(dt) : 0
    const ahead = lead > 0 ? f.foresee(lead) : []
    glass.foresee(ahead.map((h) => ({ key: h.key, kind: h.kind, speed: h.speed, pan: panOf(f, h), marbles: [h.orb, h.other], at: frameAt - h.ago * 1000 })), dt)
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
  function effectiveQuality() {
    const now = performance.now()
    return pinned ?? Math.max(governor.level, sceneUnderPointer || sceneBusy || document.activeElement?.closest('.scene') ? steps.length - 1 : 0, now - scrollAt < 180 ? pick(steps, 'plain') : 0, now - lastInteraction > 15000 ? steps.length - 1 : 0)
  }
  function setQuality() {
    if (!field) return
    const level = effectiveQuality()
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
    // Disabled or hidden, neither physics nor drawing advances.
    if (!enabled || document.hidden || !visible || !field) { glass.foresee([], 0); looping = false; return false }
    if (motionRects.length) {
      const at = performance.now()
      for (const { index, rect } of motionRects) padRects[index] = rect
      field.movePads(motionRects, dt)
      if (repelledCard) repelDemo(repelledCard)
      motionMs += performance.now() - at
      dirty = true
    }
    if (!scoped && pendingScroll !== appliedScroll) {
      tour = false; anchor = null; local.at = -1e9
      field.scroll(pendingScroll, !still)
      appliedScroll = pendingScroll
      repelDemo(document.activeElement?.closest('.scene') ?? null)
    }
    // Fresh phone steering must be consumed before deciding whether the field can stay asleep.
    readPhones(now)
    const lastInput = Math.max(local.at, tiltAt, tossAt, ...[...phones.values()].map(p => p.at))
    if (!dirty && !looping && !pageGeometry!.fieldAwake(enabled, document.hidden, false, lastInput, now)) return false
    const workAt = performance.now()
    const f = field
    const o = me()
    const mine = now - local.at < HOLD_MS
    const tilting = !!tiltPush && now - tiltAt < HOLD_MS
    if (tour && !o.orb.route.length && !o.orb.flying && o.orb.resting) { tour = false; recentre() }
    // (The marble wakes by itself when its steering or the tilt would move it: ./bounce.ts.)
    if (!tour) o.orb.target = !mine ? null : anchor ? { x: anchor.x, z: anchor.z } : f.pointAt(local.x, local.y)
    o.live = mine || tilting || now - tossAt < HOLD_MS
    o.push = tilting ? tiltPush : null
    for (const [id, ph] of phones) if (ph.gone) { f.removeOrb(id); phones.delete(id) }
    frameAt = now
    const stepAt = performance.now()
    const busy = f.step(dt)
    const holding = f.orbs().some(o => o.m.motion.phase === 'docked' || o.m.motion.phase === 'dock')
    if (fieldToggle.hasAttribute('data-holding') !== holding) {
      fieldToggle.toggleAttribute('data-holding', holding)
      fieldToggle.setAttribute('aria-label', holding ? 'Release marble' : 'Marbles on')
      fieldToggle.title = holding ? 'Release marble' : 'Marbles on — turn off'
    }
    stepMs = performance.now() - stepAt
    foresee(f, dt)
    const padsBusy = answerPads(dt)
    if (busy) pace(dt)
    setQuality()
    // A quality step clears the drawing buffer. Replace it before this frame can be presented.
    if (pinned === null) {
      const level = governor.level
      if (governor.work(performance.now() - workAt + renderWork) !== level) setQuality()
    }
    const renderAt = performance.now()
    const sharing = sceneUnderPointer || sceneBusy || !!document.activeElement?.closest('.scene')
    // A played demo gets the drawing budget; marble physics still advances, so contacts never freeze in place.
    if (!sharing || dirty || now - sceneDrawAt >= 1000 / 30) {
      f.render()
      renderWork = performance.now() - renderAt
      draws++; dirty = false; sceneDrawAt = now
    }
    looping = busy || padsBusy || mine || tilting || tour || motionRects.length > 0
    return looping
  })

  // The viewport stays active even after the headline has left it.
  let loading = false
  new IntersectionObserver(([e]) => {
    // (A scoped field loads once its hero is really in view: the bar covers the last of it first.)
    if (e.isIntersecting && enabled && visible) { void load(); wake() }
  }).observe(hero)

  async function load() {
    if (field || loading) return
    loading = true
    try {
      const [{ createField }, geometry] = await Promise.all([import('./field'), import('./obstacles')])
      pageGeometry = geometry
      // The headline's own font first, so the 3D letters are laid out the way the page wraps them.
      const f = getComputedStyle(title)
      await Promise.race([
        Promise.all([document.fonts?.ready, document.fonts?.load(`${f.fontStyle} ${f.fontWeight} ${f.fontSize} ${f.fontFamily}`).catch(() => undefined)]),
        new Promise((r) => setTimeout(r, 2500)),
      ])
      // Leave a paint opportunity for the page text before initializing WebGL.
      await new Promise<void>(resolve => setTimeout(resolve, 100))
      field = createField(stage, { coarse, still })
      palette()
      field.onHit = onHit
      field.onQuiet = (q) => glass.note(q.kind, q.speed, q.why)
      setQuality()
      preference()
      // Make the sound control visible before measuring its raised footprint.
      heroApi.onSound?.(glass.state)
      layout(false)
      // At rest on the full stop, unless the opening is about to bring it there.
      const letters = field.letters()
      const dot = letters[letters.length - 1]
      const o = me()
      if (dot) Object.assign(o.orb, { x: dot.spot[0], z: dot.spot[1], y: TOP + R, resting: true })
      field.step(0)
      if (enabled && !document.hidden) { field.render(); draws++ }
      opening()
      // Paint the headline first; document obstacles are ready before ordinary scrolling reaches them.
      window.setTimeout(() => { if (enabled && !document.hidden) { layout(); wake() } }, 200)
      new ResizeObserver(scheduleLayout).observe(hero)
      // The canvas's size in device pixels, exactly, where the browser says (moving to another screen changes it too).
      const exact = new ResizeObserver(([e]) => {
        const d = e.devicePixelContentBoxSize?.[0]
        if (!d || !field) return
        field.pixels(d.inlineSize, d.blockSize)
        rescale()
        dirty = true
        wake()
      })
      try { exact.observe(stage, { box: 'device-pixel-content-box' }) } catch { /* Safari: worked out from the CSS size */ }
      wake()
    } catch (e) {
      // No WebGL (or it failed): the headline stays the page's own text.
      console.warn('[ob.Pal] the 3D hero is off:', e)
      document.documentElement.classList.remove('field3d')
      field = null
    }
  }

  const heroApi: Hero = {
    contacts: () => ({ rects: padRects.map((rect, i) => ({ id: PAD_ID + i, owner: padOwners[i]?.className ?? '', rect })),
      marbles: field?.orbs().map(o => ({ id: o.id, speed: Math.hypot(o.orb.vx, o.orb.vy, o.orb.vz), resting: o.orb.resting })) ?? [] }),
    seed(id, x, y) {
      if (!field) return
      takeOver()
      const p = field.planeAt(x, y, TOP + R + 0.3)
      const marble = field.orb(`proof-${id}`, LIME), o = marble.orb
      Object.assign(o, { x: p.x, z: p.z, y: TOP + R + 0.3, vx: 0, vy: 0, vz: 0, target: null, route: [], flying: false, resting: false })
      delete o.mem
      marble.m.was = marble.m.now = marble.m.shown = [o.x, o.y, o.z]
      marble.life = 1
      local.at = -1e9
      wake()
    },
    showSeeds() { if (field) { field.step(0); field.render(); draws++ } },
    clearSeeds() { for (const o of field?.orbs() ?? []) if (o.id.startsWith('proof-')) field?.removeOrb(o.id) },
    onSound: null,
    get enabled() { return enabled },
    activity: () => ({ draws, layouts, active: field?.active ?? 0, enabled, moving: motionRects.length, reads: geometryReads, motionMs, stepMs, renderMs: renderWork, scroll: appliedScroll }),
    sceneActive(active) {
      const changed = active !== sceneBusy
      sceneBusy = active
      if (changed && !active) dirty = true
      return changed
    },
    toggleField() {
      enabled = !enabled
      try { localStorage.setItem('obpal-home-field', enabled ? 'on' : 'off') } catch { /* Storage can be unavailable. */ }
      preference()
      local.at = -1e9; anchor = null; tour = false
      if (enabled) { if (field) layout(); else void load(); dirty = true; wake() }
      else { looping = false; glass.foresee([], 0) }
    },
    attach(r, P, consume) {
      remote = r
      read = consume
      Pointer = P
      r.on('join', join)
      r.on('leave', (p) => { const ph = phones.get(p.id); if (ph) ph.gone = true; pointers.delete(p.id); colors.delete(p.id); dirty = true; wake() })
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
        // Where it's drawn (a step behind the physics at most).
        const [x, y, z] = o.m.shown
        const p = f.project(x, y, z)
        const v = f.project(x + o.orb.vx, y + o.orb.vy, z + o.orb.vz)
        const s = f.surface(x, z)
        // What it's on: a letter, a button (1000 + its number: pads()), the floor (-1), or nothing yet (in the air, -2);
        // held: sitting on a rim (of a letter's counter, or across a narrow gap).
        const on = Math.abs(y - o.orb.r - s.h) < 0.01 && Math.abs(o.orb.vy) < 0.5 ? s.id : -2
        return { id: o.id, x: p.x, y: p.y, vx: v.x - p.x, vy: v.y - p.y, ring: o.landingRing.material.opacity > 0, life: o.life, h: y - o.orb.r, on, held: !!o.orb.held, airborne: o.orb.flying || Math.abs(o.orb.vy) > .6 || y - o.orb.r - s.h > .05, phase: o.m.motion.phase, age: o.m.motion.age, drop: o.m.motion.drop, radius: Math.abs(f.project(x + R, y, z).x - p.x), free: f.free(p.x, p.y, Math.abs(f.project(x + R, y, z).x - p.x)) }
      })
    },
    pads: () => padEls.map((el) => el.textContent?.trim() || el.getAttribute('aria-label') || ''),
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
    gfx: () => field && { ...field.gfx(), level: effectiveQuality(), steps, pinned: pinned !== null },
    drop: (x, y) => {
      if (!field) return
      takeOver()
      const p = field.planeAt(x, y, TOP)
      Object.assign(me().orb, { x: p.x, z: p.z, y: TOP + R + 0.3, vx: 0, vy: 0, vz: 0, target: null, route: [], flying: false, toss: null, resting: false })
      anchor = null
      local.at = -1e9
      wake()
    },
    roll: (x, y, vx, vy) => {
      if (!field) return
      takeOver()
      const p = field.planeAt(x, y, R), v = field.planeAt(x + vx, y + vy, R)
      const marble = me(), o = marble.orb
      Object.assign(o, { x: p.x, z: p.z, y: R, vx: v.x - p.x, vy: 0, vz: v.z - p.z, target: null, route: [], aim: null, held: false, flying: false, toss: null, resting: false })
      delete o.mem
      Object.assign(marble.m.motion, { phase: 'ground', age: 0, drop: false, contact: false })
      marble.m.was = marble.m.now = marble.m.shown = [o.x, o.y, o.z]
      marble.ringAt = -10
      marble.landingRing.material.opacity = 0
      field.step(0)
      anchor = null
      local.at = -1e9
      wake()
    },
    counters: () => {
      if (!field) return []
      const f = field
      return f.counters().map((c) => ({ letter: c.letter, ...f.project(c.x, TOP, c.z) }))
    },
    gaps: () => {
      if (!field) return []
      const f = field
      return f.gaps(2 * R).map((g) => ({ a: g.a, b: g.b, ...f.project(g.x, TOP, g.z) }))
    },
    sim: () => ({ t: field?.clock() ?? 0, busy: looping }),
    steps: () => {
      if (!field) return []
      const sides = field.padSides()
      const height = field.padHeight
      return padEls.map((el, i) => ({
        text: el.textContent?.trim() ?? '', height, side: sides[i] ?? null,
        drawn: { dx: parseFloat(el.style.getPropertyValue('--pad-dx')) || 0, dy: parseFloat(el.style.getPropertyValue('--pad-dy')) || 0 },
      }))
    },
  }
  return heroApi
}
