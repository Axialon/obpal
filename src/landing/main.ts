import { setMarkup, html, insertMarkup } from '../ui/markup'
import { applyTheme, initialTheme } from '../ui/themes'
import { calmMarks, mountMarks } from '../ui/icons'
import { mountTopBar } from './topbar'
import { dropQuickAction, mountQuick, quickAction } from '../ui/quick'
import { mountHero } from './hero'
import { onPresence, startPairing } from './pair'
import { addActor, wake } from './ticker'
import { onOrientation, onTilt, tiltOn } from './tilt'
import { Mode, poseRelativeInView, type Quat } from '@obpal/core'
import type { Frame, Remote } from '@obpal/host'
import { armScene, desktopScene, H, playScene, pointScene, togetherScene, turnScene, W, type Point, type Scene, type SceneMode } from './scenes'

applyTheme(initialTheme())
// The logo is the page's one ambient motion; a phone lets it settle after two orbits.
mountMarks()
// The footer's logo stays still: one orbiting logo on the page is enough.
const foot = document.querySelector('.site-foot')
if (foot) calmMarks(foot, 0)
mountTopBar()

const still = matchMedia('(prefers-reduced-motion: reduce)').matches
/** A phone is the controller itself; anything bigger (a computer, a tablet) can be the screen and show a code. */
const phoneLike = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600
const desk = !phoneLike
document.documentElement.classList.toggle('phone', phoneLike)
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

// ---- hero ----

const heroEl = $('.hero')
let remote: Remote | null = null
const frames = new Map<string, { at: number; frame: Frame }>()
/** The hero and the cards share one consumption of each participant's input per animation frame. */
function readPhone(who: string, at: number) {
  let entry = frames.get(who)
  if (!entry || entry.at !== at) { entry = { at, frame: remote!.consumeOf(who, at) }; frames.set(who, entry) }
  return entry.frame
}
const hint = $('[data-hint]')
const hintText = $('[data-hint-text]')
let hintAway = 0
const settleHint = () => {
  if (hintAway) return
  hintAway = window.setTimeout(() => hint.classList.add('gone'), 1400)
}
/** ?debug=audio,gfx: a small readout of the sound and the drawing, for checking a real device. */
const debug = new Set((new URLSearchParams(location.search).get('debug') ?? '').split(',').filter(Boolean))
const hero = mountHero(heroEl, $<HTMLCanvasElement>('.hero-stage'), $('#hero-h'), { still, onInput: settleHint, meter: debug.has('audio') })
// The marbles' sound: a button in the corner says whether it's on, off, or waiting for a click (browsers start sound
// only from one), and switches it.
const soundBtn = $<HTMLButtonElement>('[data-sound]')
const soundLabel = soundBtn.querySelector('[data-sound-label]')!
const ask = matchMedia('(pointer: coarse)').matches ? 'Tap for sound' : 'Click for sound'
hero.onSound = (s) => {
  soundBtn.hidden = s === 'none'
  soundBtn.dataset.state = s
  soundBtn.setAttribute('aria-pressed', String(s === 'on'))
  soundLabel.textContent = s === 'on' ? 'Sound on' : s === 'off' ? 'Sound off' : ask
  soundBtn.title = s === 'on' ? 'Sound on' : s === 'off' ? 'Sound off' : 'Your browser starts sound after a click or a tap'
}
soundBtn.addEventListener('click', () => hero.toggleSound())
// The quick-actions tray: the marbles' sound, and pairing through the hero's own card (or, on a phone, sending the
// link to a computer); fullscreen comes with the tray.
let soundState = 'none'
const offerSound = () => {
  if (soundState === 'none') { dropQuickAction('sound'); return }
  quickAction({
    id: 'sound', label: soundState === 'on' ? 'Sound on' : 'Sound off', hint: 'The marbles’ sound', icon: soundState === 'on' ? 'sound' : 'mute', stay: true,
    pressed: () => soundState === 'on', run: () => hero.toggleSound(),
  })
}
const heard = hero.onSound
hero.onSound = (s) => { heard?.(s); soundState = s; offerSound() }
quickAction(desk ? {
  id: 'pair', label: 'Pair a phone', hint: 'The code to scan is on this page', icon: 'phone',
  run: () => {
    const card = $('[data-pair]')
    card.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' })
    card.tabIndex = -1
    card.focus({ preventScroll: true })
    card.classList.remove('pair-called'); void card.offsetWidth; card.classList.add('pair-called')
  },
} : {
  id: 'pair', label: 'Pair a phone', hint: 'Send this to a computer, then scan its code', icon: 'phone',
  run: () => $<HTMLButtonElement>('[data-send]').click(),
})
mountQuick()
// For the end-to-end test (scripts/e2e-home.mjs), as the viewer exposes its own.
Object.assign(window, { __home: { tips: () => hero.tips(), dot: () => hero.dot(), pads: () => hero.pads(), outline: (id: string) => hero.outline(id), gfx: () => hero.gfx(), audio: () => hero.audio(), drop: (x: number, y: number) => hero.drop(x, y), counters: () => hero.counters(), gaps: () => hero.gaps(), steps: () => hero.steps(), sim: () => hero.sim() } })
if (debug.size) void import('./debug').then(({ mountDebug }) => mountDebug(debug, { audio: () => hero.audio(), gfx: () => hero.gfx() }))

if (desk) {
  // A real code, made on the first sign that someone's here; each phone that scans it gets an orb.
  const pair = $('[data-pair]')
  const slot = $('[data-pair-slot]')
  pair.hidden = false
  onPresence(() => {
    startPairing(slot)
      .then(({ remote: paired, Pointer }) => {
        remote = paired
        hero.attach(remote, Pointer, readPhone)
        Object.assign(window, { __obpal: remote })
        remote.on('leave', p => frames.delete(p.id))
        remote.on('input', () => wake())
        syncTurnLayout()
        const live = () => {
          const n = paired.participants.length
          heroEl.toggleAttribute('data-live', n > 0)
          if (n) { hint.classList.remove('gone'); hintText.textContent = n > 1 ? `${n} phones: tilt to roll, flick up to toss` : 'Tilt your phone to roll, flick it up to toss'; hintAway = 0; settleHint() }
        }
        remote.on('join', live)
        remote.on('leave', live)
      })
      .catch(() => { setMarkup(slot, html`<p class="pair-wait">No code right now. <a href="/view/">Open the viewer</a> to try it.</p>`) })
  })
  hint.addEventListener('click', () => hint.classList.add('gone'))
} else {
  // On a phone: the way in is a screen elsewhere, so send the link there; meanwhile the phone paints by tilting.
  $('[data-open]').hidden = true
  const send = $<HTMLButtonElement>('[data-send]')
  send.hidden = false
  const label = send.textContent
  send.addEventListener('click', async () => {
    const url = `${location.origin}/view/`
    const text = 'Open this on a computer, then scan its code with your phone.'
    try {
      if (navigator.share) { await navigator.share({ title: 'ob.Pal', text, url }); return }
      await navigator.clipboard.writeText(url)
      send.textContent = 'Link copied: open it on your computer'
      setTimeout(() => { send.textContent = label }, 2600)
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') location.href = '/view/'
    }
  })
  // Motion is the visitor's to switch on, with one tap (and iOS's own question): from then on the phone steers the
  // light and whichever scene is on screen. Never by itself, so a phone in the hand doesn't steer while you scroll.
  if (globalThis.DeviceOrientationEvent) {
    hintText.textContent = 'Tap, then tilt your phone'
    hint.addEventListener('click', () => { void tiltUp() })
  } else {
    hintText.textContent = 'Tap to hop the marble'
    hint.addEventListener('click', () => hint.classList.add('gone'))
  }
}

/** Whether the page has asked for the tilt yet (from a tap: on the hero's hint, or on a card in a mode of motion). */
let tiltAsked = false
/** What goes on once it has (the cards' lines on what to do). */
const onTiltAsked: (() => void)[] = []
/**
 * Switch the phone's tilt on, from a tap (iOS asks first): from then on it steers the light and whichever scene is on
 * screen, the hero's hint says so, and the cards' cues say to tilt or hold (../styles/home.css: html.tilting). Whether
 * it's on.
 */
async function tiltUp(): Promise<boolean> {
  tiltAsked = true
  const on = await hero.tilt()
  if (on && !desk) {
    hintText.textContent = 'Tilt to roll, flick up to toss'
    hintAway = 0
  }
  for (const fn of onTiltAsked) fn()
  return on
}

// ---- the use cases ----

const MAKERS: Record<string, () => Scene> = { turn: turnScene, point: pointScene, arm: armScene, play: playScene, together: togetherScene, desktop: desktopScene }
/** A scene plays for this long after it comes into view, or after you last touched it or scrolled by it. */
const ACTIVE_MS = 16000
/** A pointer that stops moving stays in charge this long. */
const HOLD_MS = 3000
/** A scene with a switch keeps its hand where someone left it this long after they last touched it (then its story goes on). */
const KEEP_MS = 8000
/** A second click or tap this soon (ms) after one, and this near it (px), makes a double; a press that moves less than CLICK_PX is a click. */
const DOUBLE_MS = 450
const DOUBLE_PX = 24
const CLICK_PX = 6
/** What a card in a mode of motion says on a touch screen: before the page has asked for the tilt, once it's on, and if it couldn't be. */
const TILT_ASK = 'Tap to turn on tilt'
const TILT_ON = 'Tilt is on: tilt to steer'
const TILT_OFF = 'No tilt here: try Drag'
/** How long a card says something before its line goes back to what to do (ms). */
const SAY_MS = 2600

interface Live {
  scene: Scene; host: HTMLElement; visible: boolean; pointer: Point | null; pointerAt: number; tilt: Point | null; tiltAt: number; until: number; t: number
  /** A mouse button is down on it (the pointer stays in charge however long it's held still). */
  down: boolean
  /** How it's played, for a scene with a switch on its card. */
  mode: SceneMode | null
  /** A scene with a switch: where someone left its hand (viewBox units), and until when it stays there. */
  kept: { p: Point; until: number } | null
  /** Moving it (a drag, in a mode that drags): where the drag began (on screen), how many of the scene's units a pixel was then, and where the hand was then. */
  drag: { from: Point; per: Point; hand: Point } | null
}
const lives: Live[] = []
let turnLayout = false
function syncTurnLayout() {
  if (!remote) return
  const visible = lives.some(l => l.visible && l.scene.turn)
  if (visible === turnLayout) return
  turnLayout = visible
  remote.setLayout({ v: 1, tray: [], modes: visible ? [Mode.hold, Mode.track, Mode.point] : [Mode.tilt, Mode.point], toss: true })
}
Object.assign(window, { __turn: () => lives.find(l => l.scene.turn)?.scene.orientation?.() })

for (const host of document.querySelectorAll<HTMLElement>('[data-scene]')) {
  const make = MAKERS[host.dataset.scene ?? '']
  if (!make) continue
  const scene = make()
  host.appendChild(scene.svg)
  // A first frame, so a scene is never blank, even when nothing plays.
  for (let i = 0; i < 30; i++) scene.step(1 / 60, null, i / 60)
  const live: Live = { scene, host, visible: false, pointer: null, pointerAt: 0, tilt: null, tiltAt: -1e9, until: 0, t: 0.5, down: false, mode: null, kept: null, drag: null }
  lives.push(live)
  const toView = (x: number, y: number): Point => {
    const r = scene.svg.getBoundingClientRect()
    return { x: ((x - r.left) / r.width) * W, y: ((y - r.top) / r.height) * H }
  }
  host.addEventListener('dragstart', (e) => e.preventDefault())
  host.addEventListener('contextmenu', (e) => e.preventDefault())
  if (scene.modes) { playModes(live, toView); continue }
  const follow = (x: number, y: number) => { live.pointer = toView(x, y); live.pointerAt = performance.now(); live.until = live.pointerAt + ACTIVE_MS; wake() }
  // A mouse (or pen) plays by hovering and clicks by pressing; pressing never starts a text selection or a drag, and
  // while the button is down the scene keeps following, even past the card's edge.
  host.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') follow(e.clientX, e.clientY) })
  host.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return
    e.preventDefault()
    try { host.setPointerCapture(e.pointerId) } catch { /* the pointer is gone already */ }
    live.down = true
    follow(e.clientX, e.clientY)
    scene.press?.(live.pointer!)
  })
  const up = (e: PointerEvent) => { if (e.pointerType !== 'touch' && live.down) { live.down = false; live.pointerAt = performance.now() } }
  host.addEventListener('pointerup', up)
  host.addEventListener('pointercancel', up)
  host.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !live.down) { live.pointer = null; wake() } })
  playByTouch(host, { play: follow, move: follow, tap: (x, y) => {
    if (scene.turn && !desk && !tiltOn()) { live.pointer = null; void tiltUp(); return }
    follow(x, y); scene.press?.(live.pointer!)
  } })
}

/**
 * A scene with a switch on its card (the arm's Motion and Drag) is played through it, the same with a mouse or a
 * finger. In a mode of motion its hand follows the phone's tilt, or the mouse over the card, and a click or tap
 * anywhere works its gripper, moving nothing (on a phone whose tilt isn't on yet, the first tap switches it on). In a
 * mode that drags, a drag steers its hand by as much as the pointer moves (from wherever it's pressed, so nothing
 * jumps), a click or tap sends it there, and a double one sends it and works the gripper once it's there. Its hand
 * stays where it's left, through a change of mode, for KEEP_MS after the last touch (or until the card scrolls away);
 * then its story goes on.
 */
function playModes(live: Live, toView: (x: number, y: number) => Point) {
  const { scene, host } = live
  const say = modeSwitch(live, host.dataset.scene!)
  const drags = () => live.mode?.act === 'drag'
  const start = (x: number, y: number) => {
    keep(live)
    const r = scene.svg.getBoundingClientRect()
    live.drag = { from: { x, y }, per: { x: W / r.width, y: H / r.height }, hand: live.kept!.p }
  }
  const move = (x: number, y: number) => {
    const d = live.drag
    if (!d || !live.kept) return
    // In the scene's units as they were when the drag began: the scene lifting under a finger moves nothing.
    const dx = (x - d.from.x) * d.per.x, dy = (y - d.from.y) * d.per.y
    const want = { x: d.hand.x + dx, y: d.hand.y + dy }
    const p = scene.reach?.(want) ?? want
    // Past its reach, the hand stops at the edge, and the drag goes on from there: back again, it answers at once.
    d.hand = { x: p.x - dx, y: p.y - dy }
    live.kept.p = p
    keep(live)
  }
  const end = () => { if (live.drag) { live.drag = null; keep(live) } }
  /** A click or tap at (x, y), at `t` (the event's own time): one soon after another, near it, is a double. */
  let last = { t: -Infinity, x: 0, y: 0 }
  const press = (x: number, y: number, t: number) => {
    const double = t - last.t < DOUBLE_MS && Math.hypot(x - last.x, y - last.y) < DOUBLE_PX
    last = double ? { t: -Infinity, x: 0, y: 0 } : { t, x, y }
    if (!drags()) { keep(live); scene.grip?.(); return }
    steer(live, toView(x, y))
    if (double) scene.grip?.(live.kept!.p)
  }
  // A mouse (or pen): in a mode of motion the hand follows it over the card and a click clamps; in one that drags, a
  // press drags (on past the card's edge while the button's down), and one that doesn't move is a click.
  let down: Point | null = null
  host.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return
    if (drags()) move(e.clientX, e.clientY)
    else steer(live, toView(e.clientX, e.clientY))
  })
  host.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return
    e.preventDefault()
    if (!drags()) { press(e.clientX, e.clientY, e.timeStamp); return }
    try { host.setPointerCapture(e.pointerId) } catch { /* the pointer is gone already */ }
    down = { x: e.clientX, y: e.clientY }
    start(e.clientX, e.clientY)
  })
  const up = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || !down) return
    const click = e.type === 'pointerup' && Math.hypot(e.clientX - down.x, e.clientY - down.y) < CLICK_PX
    down = null
    end()
    if (click) press(e.clientX, e.clientY, e.timeStamp)
  }
  host.addEventListener('pointerup', up)
  host.addEventListener('pointercancel', up)
  // A finger: in a mode that drags, holding it still a moment or swiping sideways takes it, and it drags; in one of
  // motion the tilt steers, and a finger that moves scrolls the page. A tap is a click, except that in a mode of
  // motion, on a phone whose tilt the page hasn't asked for yet, it asks (iOS asks its own question too), and says how
  // that went.
  playByTouch(host, {
    play: (x, y) => { if (drags()) start(x, y) },
    move,
    end,
    tap: (x, y, t) => {
      if (!drags() && !tiltOn() && !tiltAsked) { void tiltUp().then((on) => say(on ? TILT_ON : TILT_OFF)); return }
      press(x, y, t)
    },
    takes: drags,
  })
}

/** Put a scene's hand at `p` (as near to it as it reaches), and keep it there for KEEP_MS. */
function steer(live: Live, p: Point) {
  keep(live)
  live.kept!.p = live.scene.reach?.(p) ?? p
}

/** Keep a scene's hand where it is (or where it's been left), for KEEP_MS from now; the scene plays meanwhile. */
function keep(live: Live) {
  const now = performance.now()
  if (!live.kept || now >= live.kept.until) live.kept = { p: live.scene.hold?.() ?? { x: W / 2, y: H / 2 }, until: 0 }
  live.kept.until = now + KEEP_MS
  live.until = Math.max(live.until, now + ACTIVE_MS)
  wake()
}

/** A card's caption row, under its scene (beside it, on a wide card): what's there besides the scene goes here, never on it. */
function captionOf(host: HTMLElement) {
  return host.closest('.scene')!.querySelector<HTMLElement>('.scene-cap')!
}

/**
 * The switch on a scene's card between its ways to play (Motion and Drag, for the arm): an icon each, a tooltip, arrow
 * keys between them, at the end of the card's caption row; under it, a line on what to do in the mode chosen (with a
 * finger or with a mouse, whichever this screen has). The choice lasts the visit. Returns a way for the card to say
 * something briefly on that line instead.
 */
function modeSwitch(live: Live, key: string): (text: string) => void {
  const modes = live.scene.modes!
  const touch = matchMedia('(pointer: coarse)').matches
  const store = `obpal.scene.${key}`
  let saved: string | null = null
  try { saved = sessionStorage.getItem(store) } catch { /* storage blocked: the first mode */ }
  const bar = document.createElement('div')
  bar.className = 'scene-modes'
  bar.setAttribute('role', 'radiogroup')
  bar.setAttribute('aria-label', 'How to play it')
  const buttons = modes.map((m) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-label', m.name)
    b.dataset.mode = m.id
    const does = touch ? m.touch : m.tip
    b.title = `${m.name}: ${does[0].toLowerCase()}${does.slice(1)}`
    setMarkup(b, m.icon)
    b.addEventListener('click', () => pick(m))
    return b
  })
  // Every line it may show, stacked in one place: it's as tall as the tallest, so changing it never moves the card.
  const tip = document.createElement('div')
  tip.className = 'scene-tip'
  tip.setAttribute('aria-live', 'polite')
  const lines = new Map<string, HTMLElement>()
  for (const text of touch ? [TILT_ASK, ...modes.map((m) => m.touch), TILT_ON, TILT_OFF] : modes.map((m) => m.tip)) {
    const s = document.createElement('span')
    s.textContent = text
    lines.set(text, tip.appendChild(s))
  }
  let told = '', toldAt = 0
  const show = () => {
    const m = live.mode!
    const text = told || (!touch ? m.tip : m.act !== 'motion' || tiltOn() ? m.touch : tiltAsked ? TILT_OFF : TILT_ASK)
    for (const [t, s] of lines) s.toggleAttribute('data-on', t === text)
  }
  const pick = (m: SceneMode, focus = false) => {
    // Switching keeps the hand where it is, long enough to do something in the new mode.
    if (live.mode && live.mode !== m) keep(live)
    live.mode = m
    live.drag = null
    live.host.dataset.mode = m.id
    buttons.forEach((b, i) => {
      const on = modes[i] === m
      b.setAttribute('aria-checked', String(on))
      b.tabIndex = on ? 0 : -1
      if (on && focus) b.focus()
    })
    told = ''
    show()
    try { sessionStorage.setItem(store, m.id) } catch { /* not kept */ }
  }
  bar.addEventListener('keydown', (e) => {
    const at = modes.indexOf(live.mode!)
    const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: modes.length - 1 }[e.key]
    if (to === undefined) return
    e.preventDefault()
    pick(modes[(to + modes.length) % modes.length], true)
  })
  bar.append(...buttons)
  captionOf(live.host).append(bar, tip)
  pick(modes.find((m) => m.id === saved) ?? modes[0])
  onTiltAsked.push(show)
  return (text) => {
    told = text
    const at = ++toldAt
    show()
    setTimeout(() => { if (toldAt === at) { told = ''; show() } }, SAY_MS)
  }
}

/**
 * A finger on a scene: the page keeps scrolling, and the scene still gets the gesture it wants. Holding still for a
 * moment, or swiping sideways, hands the finger to the scene (the page stops scrolling under it, the card lights up,
 * an Android phone ticks); a vertical flick stays a scroll; a quick tap is a tap (pop a target, close the gripper).
 * Which it was goes by when the finger moved (the events' own times), not by when the page heard it: a busy page
 * hears a flick late, after its hold timer has gone off, and it's still a flick.
 */
const GRAB_HOLD_MS = 150
const SLOP = 7
/**
 * What a scene does with a finger: `play` when it takes the finger, `move` as the finger moves while it has it, `end`
 * when the finger lifts, `tap` for a tap (where, and when: the event's own time). `takes` says whether it takes a finger
 * at all just now (else it only hears taps, and the page scrolls under a finger that moves).
 */
interface Touching { play(x: number, y: number): void; move(x: number, y: number): void; end?(): void; tap(x: number, y: number, t: number): void; takes?(): boolean }
/** A finger on a scene: where and when it landed, how far it's gone, whether it's left the slop yet, and whose it is. */
interface Finger { x: number; y: number; t: number; moved: number; out: boolean; mode: 'wait' | 'play' | 'scroll'; timer: number }
function playByTouch(host: HTMLElement, on: Touching) {
  const card = host.closest<HTMLElement>('.scene')!
  let g: Finger | null = null
  const takes = () => on.takes?.() ?? true
  const play = (x: number, y: number) => {
    if (!g) return
    g.mode = 'play'
    clearTimeout(g.timer)
    card.classList.add('held')
    document.documentElement.classList.add('played')
    navigator.vibrate?.(6)
    on.play(x, y)
  }
  /** The scene lets go of the finger: it lifted, or it turned out to be a scroll. */
  const letGo = () => {
    if (g?.mode === 'play') on.end?.()
    card.classList.remove('held')
  }
  const end = () => {
    if (g) clearTimeout(g.timer)
    letGo()
    g = null
  }
  host.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { end(); return }
    const t = e.touches[0]
    const f: Finger = { x: t.clientX, y: t.clientY, t: e.timeStamp, moved: 0, out: false, mode: 'wait', timer: 0 }
    f.timer = window.setTimeout(() => { if (g === f && f.mode === 'wait' && takes()) play(f.x, f.y) }, GRAB_HOLD_MS)
    g = f
  }, { passive: true })
  host.addEventListener('touchmove', (e) => {
    if (!g || g.mode === 'scroll') return
    const t = e.touches[0]
    const dx = t.clientX - g.x, dy = t.clientY - g.y
    g.moved = Math.max(g.moved, Math.hypot(dx, dy))
    if (!g.out && g.moved >= SLOP) {
      // Out of the slop, it's settled, by when the finger moved: after the hold, the scene has it, whichever way it goes;
      // before, a sideways swipe is the scene's and anything else scrolls the page, even when the hold timer went off
      // first (the page was busy, and heard this move late).
      g.out = true
      const held = e.timeStamp - g.t >= GRAB_HOLD_MS
      if (!takes() || (!held && Math.abs(dx) <= Math.abs(dy) * 1.2)) { clearTimeout(g.timer); letGo(); g.mode = 'scroll'; return }
      if (g.mode === 'wait') play(g.x, g.y)
    }
    if (g.mode !== 'play') return
    if (e.cancelable) e.preventDefault()
    on.move(t.clientX, t.clientY)
  }, { passive: false })
  host.addEventListener('touchend', (e) => {
    // A tap, even one that lingered past the hold, as long as the finger stayed put.
    const tap = g && g.mode !== 'scroll' && g.moved < SLOP && e.timeStamp - g.t < 350
    end()
    if (tap) { const t = e.changedTouches[0]; on.tap(t.clientX, t.clientY, e.timeStamp) }
  })
  host.addEventListener('touchcancel', end)
}

// On a touch screen each card says how to play its scene, beside its kind in the caption row, until you have once
// (a card with a switch says what to do in its mode, under it). Both ways it may say it are there, one shown, so the
// tilt coming on changes nothing else.
if (matchMedia('(pointer: coarse)').matches) {
  for (const l of lives) if (!l.scene.modes) insertMarkup(captionOf(l.host).querySelector('.scene-k')!, 'afterend', html`<span class="play-cue" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.6" /><circle cx="12" cy="12" r="7" opacity=".45" /></svg><span class="play-cue-t"><span>Hold to play</span><span>Tilt or hold to play</span></span></span>`)
} else {
  // A light follows the mouse across the cards, and their rims catch it.
  let raf = 0
  let at: PointerEvent | null = null
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return
    at = e
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      const card = (at?.target as Element | null)?.closest?.<HTMLElement>('.scene, .build-card')
      if (!card || !at) return
      const r = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${(at.clientX - r.left).toFixed(0)}px`)
      card.style.setProperty('--my', `${(at.clientY - r.top).toFixed(0)}px`)
    })
  }, { passive: true })
}

// Scenes come in as they scroll into view, and only those on screen play.
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const card = e.target as HTMLElement
    if (e.isIntersecting) card.classList.add('in')
    const live = lives.find((l) => card.contains(l.host))
    if (!live) continue
    live.visible = e.isIntersecting
    // Scrolled away, a scene's hand is let go: back in view, its story goes on.
    if (!e.isIntersecting) { live.kept = null; live.drag = null }
    if (e.isIntersecting && !still) { live.until = performance.now() + ACTIVE_MS; wake() }
  }
  syncTurnLayout()
}, { threshold: 0.18 })
// Cards in a row arrive one after another (the delay is on the arrival only, not on hover).
// Headings, the build cards and the last word arrive the same way.
document.querySelectorAll<HTMLElement>('.sec-head, .build-card, .closer').forEach((el, i) => { el.classList.add('rise'); el.style.transitionDelay = `${el.classList.contains('build-card') ? (i % 3) * 70 : 0}ms`; seen.observe(el) })
document.querySelectorAll('.scene').forEach((s, i) => { (s as HTMLElement).style.transitionDelay = `${(i % 3) * 70}ms, ${(i % 3) * 70}ms, 0ms, 0ms`; seen.observe(s) })

// Reading down the page keeps the scenes in view playing.
addEventListener('scroll', () => {
  if (still) return
  const now = performance.now()
  let any = false
  for (const l of lives) if (l.visible) { l.until = Math.max(l.until, now + ACTIVE_MS); any = true }
  if (any) wake()
}, { passive: true })

// With the tilt on, whichever scene is on screen plays under it (a finger or the mouse still comes first). A scene
// with a switch, in a mode of motion, has its hand steered by it: a real tilt takes the hand from its story, and from
// then on every reading steers it.
onTilt((t) => {
  const now = performance.now()
  const cl = (v: number) => Math.max(-1, Math.min(1, v / 24))
  for (const l of lives) {
    if (!l.visible) continue
    if (l.scene.turn) continue
    l.tilt = { x: W / 2 + cl(t.x) * W * 0.42, y: H / 2 + cl(t.y) * H * 0.4 }
    if (l.mode) { if (l.mode.act === 'motion' && (t.wake || l.kept)) steer(l, l.tilt); continue }
    if (t.wake) { l.tiltAt = now; l.until = Math.max(l.until, now + ACTIVE_MS); wake() }
  }
})

onOrientation((q, generation) => {
  for (const l of lives) if (l.scene.turn) {
    l.scene.turn(q, `local:${generation}`)
    l.until = Infinity
  }
  wake()
})

let hand: { who: string; gen: number; q: Quat } | null = null
let remoteTurn = false
function turnPhones(now: number) {
  const lead = remote?.participants.find(p => p.lead)
  const f = lead ? readPhone(lead.id, now) : null
  let q: Quat | null = null, grab = ''
  if (f?.connected && f.mode === Mode.hold && f.clutch) { q = f.qRel; grab = `${lead!.id}:${f.grab}` }
  const pose = f?.pose
  if (f?.connected && f.mode === Mode.track && pose?.tracked && pose.touching) {
    if (!hand || hand.who !== lead!.id || hand.gen !== pose.gen) hand = { who: lead!.id, gen: pose.gen, q: pose.q }
    q = poseRelativeInView(hand.q, pose.q); grab = `${lead!.id}:pose:${pose.gen}`
  } else hand = null
  for (const l of lives) if (l.scene.turn && (q || remoteTurn)) {
    l.scene.turn(q, grab)
    l.until = q ? Infinity : now + ACTIVE_MS
  }
  remoteTurn = !!q
}

addActor((now, dt) => {
  turnPhones(now)
  let busy = false
  for (const l of lives) {
    if (!l.visible || now > l.until) continue
    if (l.kept && now >= l.kept.until && !l.drag) l.kept = null
    // A scene with a switch: its hand where it's been put (by a drag, a click, the mouse or the tilt), else its story.
    const modes = !!l.scene.modes
    const pointing = modes ? !!l.kept : !!l.pointer && (l.down || now - l.pointerAt < HOLD_MS)
    const tilted = !modes && !pointing && !!l.tilt && now - l.tiltAt < HOLD_MS
    const turning = !!l.scene.turn && (tiltOn() || remoteTurn)
    if (!pointing && !tilted && !turning && still) continue
    l.t += dt
    l.scene.step(dt, pointing ? (modes ? l.kept!.p : l.pointer) : tilted ? l.tilt : null, l.t)
    busy = true
  }
  return busy
})
