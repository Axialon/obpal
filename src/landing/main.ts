// The home page: a hero you bounce light across (./hero.ts), the use cases as live scenes (./scenes.ts), and the ways in.
import { applyTheme, initialTheme } from '../ui/themes'
import { calmMarks, mountMarks } from '../ui/icons'
import { mountTopBar } from './topbar'
import { mountHero } from './hero'
import { onPresence, startPairing } from './pair'
import { addActor, wake } from './ticker'
import { onTilt } from './tilt'
import { armScene, desktopScene, H, playScene, pointScene, togetherScene, turnScene, W, type Point, type Scene } from './scenes'

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
// For the end-to-end test (scripts/e2e-home.mjs), as the viewer exposes its own.
Object.assign(window, { __home: { tips: () => hero.tips(), dot: () => hero.dot(), pads: () => hero.pads(), gfx: () => hero.gfx(), audio: () => hero.audio() } })
if (debug.size) void import('./debug').then(({ mountDebug }) => mountDebug(debug, { audio: () => hero.audio(), gfx: () => hero.gfx() }))

if (desk) {
  // A real code, made on the first sign that someone's here; each phone that scans it gets an orb.
  const pair = $('[data-pair]')
  const slot = $('[data-pair-slot]')
  pair.hidden = false
  onPresence(() => {
    startPairing(slot)
      .then(({ remote, Pointer }) => {
        hero.attach(remote, Pointer)
        Object.assign(window, { __obpal: remote })
        const live = () => {
          const n = remote.participants.length
          heroEl.toggleAttribute('data-live', n > 0)
          if (n) { hint.classList.remove('gone'); hintText.textContent = n > 1 ? `${n} phones: tilt to roll, flick up to toss` : 'Tilt your phone to roll, flick it up to toss'; hintAway = 0; settleHint() }
        }
        remote.on('join', live)
        remote.on('leave', live)
      })
      .catch(() => { slot.innerHTML = '<p class="pair-wait">No code right now. <a href="/view/">Open the viewer</a> to try it.</p>' })
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
    const text = 'Open this on a computer or TV, then scan its code with your phone.'
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
    hint.addEventListener('click', async () => {
      if (!(await hero.tilt())) return
      hintText.textContent = 'Tilt to roll, flick up to toss'
      hintAway = 0
      for (const cue of document.querySelectorAll('.play-cue span')) cue.textContent = 'Tilt or hold to play'
    })
  } else {
    hintText.textContent = 'Tap to hop the marble'
    hint.addEventListener('click', () => hint.classList.add('gone'))
  }
}

// ---- the use cases ----

const MAKERS: Record<string, () => Scene> = { turn: turnScene, point: pointScene, arm: armScene, play: playScene, together: togetherScene, desktop: desktopScene }
/** A scene plays for this long after it comes into view, or after you last touched it or scrolled by it. */
const ACTIVE_MS = 16000
/** A pointer that stops moving stays in charge this long. */
const HOLD_MS = 3000

interface Live { scene: Scene; host: HTMLElement; visible: boolean; pointer: Point | null; pointerAt: number; tilt: Point | null; tiltAt: number; until: number; t: number }
const lives: Live[] = []

for (const host of document.querySelectorAll<HTMLElement>('[data-scene]')) {
  const make = MAKERS[host.dataset.scene ?? '']
  if (!make) continue
  const scene = make()
  host.appendChild(scene.svg)
  // A first frame, so a scene is never blank, even when nothing plays.
  for (let i = 0; i < 30; i++) scene.step(1 / 60, null, i / 60)
  const live: Live = { scene, host, visible: false, pointer: null, pointerAt: 0, tilt: null, tiltAt: -1e9, until: 0, t: 0.5 }
  lives.push(live)
  const toView = (x: number, y: number): Point => {
    const r = scene.svg.getBoundingClientRect()
    return { x: ((x - r.left) / r.width) * W, y: ((y - r.top) / r.height) * H }
  }
  const follow = (x: number, y: number) => { live.pointer = toView(x, y); live.pointerAt = performance.now(); live.until = live.pointerAt + ACTIVE_MS; wake() }
  // A mouse (or pen) plays by hovering and clicks by pressing; pressing never starts a text selection.
  host.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') follow(e.clientX, e.clientY) })
  host.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') return; e.preventDefault(); follow(e.clientX, e.clientY); scene.press?.(live.pointer!) })
  host.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') { live.pointer = null; wake() } })
  playByTouch(host, follow, () => { if (live.pointer) scene.press?.(live.pointer) })
  host.addEventListener('contextmenu', (e) => e.preventDefault())
}

/**
 * A finger on a scene: the page keeps scrolling, and the scene still gets the gesture it wants. Holding still for a
 * moment, or swiping sideways, hands the finger to the scene (the page stops scrolling under it, the card lights up,
 * an Android phone ticks); a vertical flick stays a scroll; a quick tap is a tap (pop a target, close the gripper).
 */
const GRAB_HOLD_MS = 150
const SLOP = 7
function playByTouch(host: HTMLElement, follow: (x: number, y: number) => void, tap: () => void) {
  const card = host.closest<HTMLElement>('.scene')!
  let g: { x: number; y: number; t: number; moved: number; mode: 'wait' | 'play' | 'scroll'; timer: number } | null = null
  const play = (x: number, y: number) => {
    if (!g) return
    g.mode = 'play'
    clearTimeout(g.timer)
    card.classList.add('held')
    document.documentElement.classList.add('played')
    navigator.vibrate?.(6)
    follow(x, y)
  }
  const end = () => { if (g) clearTimeout(g.timer); g = null; card.classList.remove('held') }
  host.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { end(); return }
    const t = e.touches[0]
    const x = t.clientX, y = t.clientY
    g = { x, y, t: e.timeStamp, moved: 0, mode: 'wait', timer: window.setTimeout(() => { if (g?.mode === 'wait') play(g.x, g.y) }, GRAB_HOLD_MS) }
  }, { passive: true })
  host.addEventListener('touchmove', (e) => {
    if (!g || g.mode === 'scroll') return
    const t = e.touches[0]
    g.moved = Math.max(g.moved, Math.hypot(t.clientX - g.x, t.clientY - g.y))
    if (g.mode === 'wait') {
      const dx = t.clientX - g.x, dy = t.clientY - g.y
      if (Math.hypot(dx, dy) < SLOP) return
      if (Math.abs(dx) > Math.abs(dy) * 1.2) play(t.clientX, t.clientY)
      else { g.mode = 'scroll'; clearTimeout(g.timer); return }
    }
    if (e.cancelable) e.preventDefault()
    follow(t.clientX, t.clientY)
  }, { passive: false })
  host.addEventListener('touchend', (e) => {
    // A tap, even one that lingered past the hold, as long as the finger stayed put.
    if (g && g.mode !== 'scroll' && g.moved < SLOP && e.timeStamp - g.t < 350) { const t = e.changedTouches[0]; follow(t.clientX, t.clientY); tap() }
    end()
  })
  host.addEventListener('touchcancel', end)
}

// On a touch screen each scene says how to play it, until you have once.
if (matchMedia('(pointer: coarse)').matches) {
  for (const l of lives) l.host.insertAdjacentHTML('beforeend', '<span class="play-cue" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.6" /><circle cx="12" cy="12" r="7" opacity=".45" /></svg><span>Hold to play</span></span>')
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
    if (e.isIntersecting && !still) { live.until = performance.now() + ACTIVE_MS; wake() }
  }
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

// With the tilt on, whichever scene is on screen plays under it (a finger or the mouse still comes first).
onTilt((t) => {
  const now = performance.now()
  const cl = (v: number) => Math.max(-1, Math.min(1, v / 24))
  for (const l of lives) {
    if (!l.visible) continue
    l.tilt = { x: W / 2 + cl(t.x) * W * 0.42, y: H / 2 + cl(t.y) * H * 0.4 }
    if (t.wake) { l.tiltAt = now; l.until = Math.max(l.until, now + ACTIVE_MS); wake() }
  }
})

addActor((now, dt) => {
  let busy = false
  for (const l of lives) {
    if (!l.visible || now > l.until) continue
    const pointing = !!l.pointer && now - l.pointerAt < HOLD_MS
    const tilted = !pointing && !!l.tilt && now - l.tiltAt < HOLD_MS
    if (!pointing && !tilted && still) continue
    l.t += dt
    l.scene.step(dt, pointing ? l.pointer : tilted ? l.tilt : null, l.t)
    busy = true
  }
  return busy
})
