/**
 * The home page's hero: ribbons of light that go where a controller points. The mouse, a tap, or the phone's own
 * tilt moves the lime one; on a computer, phones that scan the code each get a ribbon in their own colour, steered
 * from their own sensors like the viewer's Wii-style pointer. With nobody steering, the light draws one deliberate
 * stroke (./stroke.ts): once round the headline, like the satellite round the logo's ring, then along beneath it to
 * land on its full stop, where it rests. Nothing draws while nothing moves.
 */
import { Ribbon, glowSprite, hexRgb, type RGB, type RibbonLook } from './ribbon'
import { orbitStroke, pointAt, walk, walkTime, type Headline, type Stroke } from './stroke'
import { addActor, wake } from './ticker'
import { onTilt, recentre, startTilt, tiltOn } from './tilt'
import type { Participant, Remote } from '@obpal/host'
import type { ScreenPointer } from '../viewer/pointer'

const LIME: RGB = [198, 255, 52]
const CORE: RGB = [244, 255, 214]
const HAZE: RGB = [179, 164, 255]
const UV: RGB = [92, 62, 245]
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const ME: RibbonLook = { face: LIME, core: CORE, back: mix(UV, HAZE, 0.3), haze: HAZE }
const lookOf = (hex: string): RibbonLook => { const c = hexRgb(hex); return { face: c, core: mix(c, [255, 255, 255], 0.75), back: mix(UV, c, 0.35), haze: HAZE } }

/** A hand that stops moving keeps its ribbon this long; then the ribbon rests where it was left. */
const HOLD_MS = 2600
/** A phone's ribbon rests after this long without moving. */
const PHONE_REST_MS = 6000
/** How much of a resting ribbon stays on screen. */
const REST_ALPHA = 0.34
/** Coming back into view, a resting ribbon glints (brightens and settles again) rather than moving. */
const GLINT_MS = 900
/** Tilting this many degrees takes the ribbon to the edge of the hero. (Smoothing and stillness: ./tilt.ts.) */
const TILT_REACH = 28

interface Strand { ribbon: Ribbon; look: RibbonLook; sprite: HTMLCanvasElement; x: number; y: number; at: number; gone: boolean }

export interface Hero {
  /** Phones join through this remote (a computer's pairing card), each with its own ribbon. */
  attach(remote: Remote, pointer: typeof ScreenPointer): void
  /** Start following the phone's tilt (on a phone; iOS asks first, from a tap). */
  tilt(): Promise<boolean>
  readonly tilting: boolean
  /** Where each ribbon's stick is (for tests). */
  tips(): { id: string; x: number; y: number; life: number }[]
}

export function mountHero(hero: HTMLElement, stage: HTMLCanvasElement, title: HTMLElement, opts: { still: boolean; onInput?: () => void }): Hero {
  const g = stage.getContext('2d')!
  const still = opts.still
  let W = 1, H = 1, scale = 1
  let box = { x: 0, y: 0, w: 1, h: 1 }
  let visible = true
  let ribbonWidth = 20
  const coarse = matchMedia('(pointer: coarse)').matches
  /** What the last frame drew over (CSS px), so the next one clears only that and what it draws now. */
  let drawn: [number, number, number, number] | null = null
  const strands = new Map<string, Strand>()
  const local = { x: 0, y: 0, at: -1e9 }
  /** The stroke, and when its walk began (it waits for the headline's font, so it's drawn round the real letters). */
  let stroke = null as Stroke | null
  /** A stroke for a layout that changed mid-walk: it takes over once the walk has landed, never during it. */
  let pending = null as Stroke | null
  const walking = () => walkFrom !== Infinity && (performance.now() - walkFrom) / 1000 < walkT
  let walkFrom = Infinity
  let walkT = 1
  let glintFrom = -1e9
  /** The tilt takes over only once the stroke has landed (picking the phone up mustn't hijack it). */
  let flourished = still

  const strand = (look: RibbonLook, x: number, y: number): Strand => {
    const ribbon = new Ribbon(48, ribbonWidth)
    ribbon.reset(x, y)
    return { ribbon, look, sprite: glowSprite(look.face, look.core), x, y, at: -1e9, gone: false }
  }
  const me = strand(ME, -70, 0)
  strands.set('me', me)

  /** The headline's text box and its full stop, in the hero's px. */
  function headline(): Headline | null {
    const r = hero.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(title)
    const rects = [...range.getClientRects()].filter((q) => q.width > 0 && q.height > 0)
    let last: Text | null = null
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) { const t = walker.currentNode as Text; if (t.data.trim()) last = t }
    if (!rects.length || !last) return null
    const end = last.data.trimEnd().length
    range.setStart(last, end - 1)
    range.setEnd(last, end)
    const d = range.getBoundingClientRect()
    return {
      left: Math.min(...rects.map((q) => q.left)) - r.left, right: Math.max(...rects.map((q) => q.right)) - r.left,
      top: Math.min(...rects.map((q) => q.top)) - r.top, bottom: Math.max(...rects.map((q) => q.bottom)) - r.top,
      // The full stop sits on the baseline, about a quarter of the line up from the bottom of its box.
      dot: { x: d.left - r.left + d.width / 2, y: d.bottom - r.top - d.height * 0.27 },
    }
  }

  function size() {
    const r = hero.getBoundingClientRect()
    const t = title.getBoundingClientRect()
    W = Math.max(1, r.width); H = Math.max(1, r.height)
    box = { x: t.left - r.left, y: t.top - r.top, w: t.width, h: t.height }
    // A phone draws the soft ribbon at 1.5x: sharp enough, and far fewer pixels to fill each frame.
    scale = Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2)
    drawn = null
    stage.width = Math.round(W * scale)
    stage.height = Math.round(H * scale)
    ribbonWidth = Math.max(10, Math.min(18, Math.min(W, H) * 0.024))
    for (const s of strands.values()) s.ribbon.width = ribbonWidth
    const h = headline()
    const next = h ? orbitStroke(h, W) : null
    if (walking()) pending = next
    else {
      stroke = next
      // At rest on the full stop, the light follows it wherever the headline now puts it.
      if (stroke && flourished && walkFrom !== Infinity && performance.now() - local.at >= HOLD_MS) { const [x, y] = pointAt(stroke, stroke.len); me.x = x; me.y = y }
    }
    draw()
  }
  const ro = new ResizeObserver(() => { size(); wake() })
  ro.observe(hero)
  ro.observe(title)

  // ---- your own hand: the mouse, a tap, the phone's tilt ----

  const follow = (x: number, y: number) => {
    local.x = x; local.y = y; local.at = performance.now()
    opts.onInput?.()
    wake()
  }
  const at = (e: PointerEvent) => { const r = hero.getBoundingClientRect(); follow(e.clientX - r.left, e.clientY - r.top) }
  /** Pressing a button or a link is that, not painting. */
  const onControl = (e: Event) => !!(e.target as Element | null)?.closest?.('a, button')
  // A mouse paints as it moves. A finger only when it taps: touching to scroll leaves the light where it is.
  let press: { x: number; y: number; t: number } | null = null
  hero.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') at(e) }, { passive: true })
  hero.addEventListener('pointerdown', (e) => { if (onControl(e)) return; if (e.pointerType === 'mouse') at(e); else press = { x: e.clientX, y: e.clientY, t: e.timeStamp } }, { passive: true })
  hero.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse' && !onControl(e) && press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10 && e.timeStamp - press.t < 350) at(e)
    press = null
  }, { passive: true })
  hero.addEventListener('pointercancel', () => { press = null }, { passive: true })

  // The phone's tilt (once it's on) moves the lime ribbon, but only after the opening stroke has landed. A small drift
  // moves its target quietly (a steady hand never keeps the page drawing); a real tilt wakes it.
  onTilt((t) => {
    if (!visible || !flourished) return
    const cl = (v: number) => Math.max(-1, Math.min(1, v / TILT_REACH))
    const x = W / 2 + cl(t.x) * W * 0.42, y = H * 0.5 + cl(t.y) * H * 0.38
    if (t.wake) follow(x, y)
    else { local.x = x; local.y = y }
  })

  // ---- phones on a computer: one ribbon each, from its Wii-style pointer ----

  let remote: Remote | null = null
  let Pointer: typeof ScreenPointer | null = null
  const pointers = new Map<string, ScreenPointer>()
  function join(p: Participant) {
    const had = strands.get(p.id)
    if (had) had.gone = false
    else strands.set(p.id, strand(lookOf(p.color), W / 2, H / 2))
    strands.get(p.id)!.at = performance.now()
    if (!pointers.has(p.id)) pointers.set(p.id, new Pointer!())
    wake()
  }
  function readPhones(now: number) {
    if (!remote) return
    for (const p of remote.participants) {
      if (!pointers.has(p.id) || strands.get(p.id)?.gone !== false) join(p)
      const s = strands.get(p.id)!
      const f = remote.consumeOf(p.id, now)
      const st = pointers.get(p.id)!.step(f.aim, f.pad1, W, H)
      if (Math.abs(st.dx) + Math.abs(st.dy) > 0.25) s.at = now
      // Off the screen, the ribbon waits at the edge it left by.
      s.x = Math.max(-20, Math.min(W + 20, st.x))
      s.y = Math.max(-20, Math.min(H + 20, st.y))
    }
  }

  // ---- drawing ----

  let lit = { x: -999, y: -999, a: 0 }
  function draw() {
    let area: [number, number, number, number] | null = null
    for (const s of strands.values()) {
      const r = s.ribbon.bounds()
      area = area ? [Math.min(area[0], r[0]), Math.min(area[1], r[1]), Math.max(area[2], r[2]), Math.max(area[3], r[3])] : r
    }
    const clear = drawn && area ? [Math.min(drawn[0], area[0]), Math.min(drawn[1], area[1]), Math.max(drawn[2], area[2]), Math.max(drawn[3], area[3])] : null
    if (clear) g.clearRect(Math.floor(clear[0] * scale), Math.floor(clear[1] * scale), Math.ceil((clear[2] - clear[0]) * scale) + 2, Math.ceil((clear[3] - clear[1]) * scale) + 2)
    else g.clearRect(0, 0, stage.width, stage.height)
    drawn = area
    let best: Strand | null = null
    for (const s of strands.values()) {
      const r = s.ribbon
      const alpha = s === me ? REST_ALPHA + (1 - REST_ALPHA) * r.life : r.life
      r.draw(g, s.look, scale, alpha)
      if (alpha > 0.02) {
        g.save()
        g.globalCompositeOperation = 'lighter'
        g.globalAlpha = Math.min(1, alpha * 1.1)
        const d = ribbonWidth * scale * 4.4
        g.drawImage(s.sprite, r.tipX * scale - d / 2, r.tipY * scale - d / 2, d, d)
        g.restore()
      }
      if (!best || s.at > best.at) best = s
    }
    // The headline catches the light of whoever moved last (at rest, the light on its full stop).
    const s = best ?? me
    const a = s.ribbon.life
    if (Math.abs(a - lit.a) > 0.004 || Math.abs(s.ribbon.tipX - box.x - lit.x) > 0.5 || Math.abs(s.ribbon.tipY - box.y - lit.y) > 0.5) {
      lit = { x: s.ribbon.tipX - box.x, y: s.ribbon.tipY - box.y, a }
      title.style.setProperty('--lx', `${lit.x.toFixed(1)}px`)
      title.style.setProperty('--ly', `${lit.y.toFixed(1)}px`)
      title.style.setProperty('--lr', `${(40 + 230 * a).toFixed(0)}px`)
    }
  }

  addActor((now, dt) => {
    if (!visible) return false
    readPhones(now)
    let busy = false
    const phonesLive = [...strands.values()].some((s) => s !== me && !s.gone && now - s.at < PHONE_REST_MS)
    const mine = now - local.at < HOLD_MS
    // A frame's clock can run a little behind the moment the walk was started: that frame is its first, not before it.
    const u = walkFrom === Infinity ? -1 : Math.max(0, (now - walkFrom) / 1000 / walkT)
    const playing = !still && !!stroke && !mine && !phonesLive && u >= 0 && u < 1
    const glinting = now - glintFrom < GLINT_MS
    if (mine) {
      me.x = local.x; me.y = local.y; me.at = local.at
      walkFrom = Infinity
      flourished = true
    } else if (playing) {
      // Walking the stroke: the stick is on the path, and the ribbon traces it exactly behind.
      const [x, y] = pointAt(stroke!, stroke!.len * walk(u))
      me.x = x; me.y = y
    }
    // Landed: from here the phone's tilt may take over, measured from however it's held now. A layout that changed
    // during the walk takes effect now, and the resting light glides to where the full stop is.
    if (!flourished && walkFrom !== Infinity && u >= 1) {
      flourished = true
      recentre()
      if (pending) { stroke = pending; pending = null; const [x, y] = pointAt(stroke, stroke.len); me.x = x; me.y = y }
    }
    busy = me.ribbon.step(dt, me.x, me.y, playing ? { follow: 45, lit: true, keep: 0.7 } : { follow: 20, lit: mine || glinting, keep: mine ? 0.86 : 0.8 }) || busy
    busy = busy || mine || playing || glinting
    for (const [id, s] of strands) {
      if (s === me) continue
      const live = !s.gone && now - s.at < PHONE_REST_MS
      busy = s.ribbon.step(dt, s.x, s.y, { follow: 22, lit: live, keep: 0.86 }) || busy
      if (s.gone && s.ribbon.life < 0.01) strands.delete(id)
      busy = busy || live
    }
    draw()
    return busy
  })

  // Only on screen does anything draw; coming back, the resting ribbon glints.
  new IntersectionObserver(([e]) => {
    const was = visible
    visible = e.isIntersecting
    if (visible && !was && !still) { glintFrom = performance.now(); wake() }
  }).observe(hero)

  size()
  if (still) {
    // No motion: the ribbon is laid out as the stroke leaves it, beneath the headline and on its full stop.
    if (stroke) {
      const T = walkTime(stroke.len)
      me.ribbon.reset(stroke.xs[0], stroke.ys[0])
      for (let t = 0; t <= T; t += 1 / 60) { const [x, y] = pointAt(stroke, stroke.len * walk(t / T)); me.ribbon.step(1 / 60, x, y, { follow: 45, lit: true, keep: 0.7 }) }
      const [x, y] = pointAt(stroke, stroke.len)
      for (let i = 0; i < 240; i++) me.ribbon.step(1 / 60, x, y, { follow: 20, lit: false, keep: 0.8 })
      me.x = x; me.y = y
    }
    draw()
  } else {
    // Waiting at the start, off the left edge, until the stroke begins.
    me.x = stroke ? stroke.xs[0] : -70
    me.y = stroke ? stroke.ys[0] : H * 0.66
    me.ribbon.reset(me.x, me.y)
    // The stroke starts once the headline's font is in (or after a while anyway), so it goes round the real letters.
    const go = () => {
      if (walkFrom !== Infinity || local.at > 0) return
      size()
      if (!stroke) { flourished = true; return }
      me.x = stroke.xs[0]; me.y = stroke.ys[0]
      me.ribbon.reset(me.x, me.y)
      walkT = walkTime(stroke.len)
      walkFrom = performance.now()
      wake()
    }
    void document.fonts?.ready.then(go)
    setTimeout(go, 2500)
  }

  return {
    attach(r, P) {
      remote = r
      Pointer = P
      r.on('join', join)
      r.on('leave', (p) => { const s = strands.get(p.id); if (s) s.gone = true; pointers.delete(p.id); wake() })
      r.on('recenter', (p) => pointers.get(p.id)?.recenter())
      r.on('input', () => wake())
    },
    tilt: startTilt,
    get tilting() { return tiltOn() },
    tips: () => [...strands].map(([id, s]) => ({ id, x: s.ribbon.tipX, y: s.ribbon.tipY, life: s.ribbon.life })),
  }
}
