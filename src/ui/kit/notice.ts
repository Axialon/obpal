/**
 * ob.Pal's notices: where a page's short messages appear, on every surface (the phone, the viewer, the sims).
 *
 * Messages come in five tiers, and each lives where its job needs it. An alert (the screen stopped the arms) and a state
 * (the link is down, waiting to be let in) stay until what they say ends, in their own banners with their own actions. A
 * ceremony shows while it is useful and then folds by itself: the pairing card does (packages/host/src/chip.ts), and the
 * phone's trust notice does here (tier 'ceremony', above the toasts). A coach mark (src/ui/hints.ts) fades and gives way to
 * all of them. The fifth tier is the toast: short feedback that
 *   - lasts as long as its words need (noticeDuration), and a notice with a button on it longer;
 *   - waits its turn behind at most three others, and is never shown twice in a row (notice-queue.ts);
 *   - holds still while a pointer or a finger is on it, focus is in it, or the page is hidden, and then has a moment left;
 *   - goes away on its x (a 44 px target), on a drag of 50 px starting on it, and on Escape;
 *   - sits in one reserved slot, never moves the page, takes the pointer only on its own buttons (a drag that starts on it
 *     is read from the document, so what is beneath keeps working), and keeps still for reduced motion.
 * A screen reader hears it through two live regions that are in the page from the start (polite, and assertive for an
 * error); focus never moves.
 *
 * Built from elements, never parsed markup, so it works under a strict Content Security Policy and Trusted Types.
 */
import '../../styles/notice.css'
import {
  ACTION_MIN_MS, countdown, emptyQueue, finish, isSwipe, noticeDuration, offer, pause, remaining, resume,
  type Countdown, type Entry, type NoticeTone, type Step,
} from './notice-queue'

export type { NoticeTone } from './notice-queue'
export { noticeDuration } from './notice-queue'

export type CloseReason = 'time' | 'dismiss' | 'swipe' | 'action' | 'replaced' | 'cleared' | 'dropped'

export interface NoticeSpec {
  /** Names a notice: the same id again replaces its words. Default: a fresh one each time. */
  id?: string
  /** What it says. */
  text?: string
  /** Or its own content (a sentence with buttons, say). A screen reader hears `say`, else its text. */
  node?: Node
  say?: string
  /** The page keeps its own live region and announces the words itself. */
  announce?: boolean
  /** info (default), ok, warn or bad. An error stays longer and is read out at once. */
  tone?: NoticeTone
  /** A stroke icon (24 × 24, currentColor) for the tone's own; false for none (the content brings its own). */
  icon?: SVGElement | false
  /** One button on the notice. It runs, and the notice goes (unless `keep`). */
  action?: { label: string; run: () => void; keep?: boolean }
  /** How long it shows, in ms. Default: noticeDuration of its words. */
  ms?: number
  /**
   * toast (default): short feedback, one at a time through the queue. ceremony: a notice that is shown while it is useful
   * and then folds by itself (the phone's trust notice): it sits above the toasts, is never queued or de-duplicated, and
   * gives `ms` as the time it stays.
   */
  tier?: 'toast' | 'ceremony'
  /**
   * It answers something the person just did (a device they plugged in): it takes the place of a toast that is showing, and
   * that toast waits at the head of the queue.
   */
  urgent?: boolean
  /**
   * It takes no pointer at all and has no x: a touch on it reaches what is under it. For a page whose every part is a
   * control (the phone), where a notice has to sit over some of them; it goes by itself, on a drag of 50 px that starts on
   * it, and on Escape.
   */
  passive?: boolean
  /** It has an x. Default true. */
  closable?: boolean
  /** The x's name for a screen reader. */
  closeLabel?: string
  /** Extra classes on the notice and on its x (for a page's own styles, and for the tests that look for them). */
  className?: string
  closeClass?: string
  /** It is over, and why. */
  onClose?: (why: CloseReason) => void
}

interface Live {
  id: string
  spec: NoticeSpec
  entry: Entry
  el: HTMLElement | null
  cd: Countdown | null
  timer: number
  holds: Set<'hover' | 'focus' | 'press'>
}

/** What the slot sits under: an element, or a function that says which (a page whose layout turns). */
type Anchor = HTMLElement | null | (() => HTMLElement | null)

const SVG = 'http://www.w3.org/2000/svg'
/** What is left, at the least, once a hold ends: a notice never vanishes the moment it is let go of. */
const RESUME_FLOOR_MS = 1500
const EXIT_MS = 220

const live = new Map<string, Live>()
let queue = emptyQueue()
let seq = 0
let host: HTMLElement | null = null
let lane: HTMLElement
let rail: HTMLElement
let polite: HTMLElement
let assertive: HTMLElement
let anchor: Anchor = null
let anchorObserver: ResizeObserver | null = null
let away = false
let wired = false
const listeners = new Set<() => void>()

const now = () => performance.now()

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  e.append(...kids)
  return e
}

function svg(...paths: string[]): SVGSVGElement {
  const s = document.createElementNS(SVG, 'svg')
  s.setAttribute('viewBox', '0 0 24 24')
  s.setAttribute('aria-hidden', 'true')
  s.setAttribute('focusable', 'false')
  s.setAttribute('class', 'nt-glyph')
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path')
    p.setAttribute('d', d)
    s.append(p)
  }
  return s
}

const GLYPH: Record<NoticeTone, () => SVGSVGElement> = {
  info: () => svg('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5.2', 'M12 7.8h.01'),
  ok: () => svg('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'm8.3 12.4 2.6 2.6 4.8-5.4'),
  warn: () => svg('M12 4 3.2 19.5h17.6L12 4Z', 'M12 10v4.2', 'M12 17.2h.01'),
  bad: () => svg('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7.6v5.6', 'M12 16.6h.01'),
}

/** The host: two live regions that are in the page from the start, and the slot the notices appear in. */
function ensureHost(): HTMLElement | null {
  if (host?.isConnected) return host
  if (typeof document === 'undefined' || !document.body) return null
  polite = el('div', 'nt-sr', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
  assertive = el('div', 'nt-sr', { role: 'alert', 'aria-atomic': 'true' })
  rail = el('div', 'nt-lane nt-rail')
  lane = el('div', 'nt-lane')
  host = el('div', 'obpal-notices', {}, polite, assertive, rail, lane)
  document.body.append(host)
  place()
  return host
}

/**
 * A page that shows notices calls this when it starts: the live regions are then in the page before the first notice (a live
 * region that arrives with its text is announced only by some readers).
 */
export function mountNotices() { ensureHost() }

/** Say it to a screen reader: the region is emptied first so the same words twice are heard twice. */
function say(text: string, urgent: boolean) {
  const region = urgent ? assertive : polite
  region.textContent = ''
  requestAnimationFrame(() => { region.textContent = text })
}

// ---- where it sits ---------------------------------------------------------------------------------------------------

/**
 * Put the slot just under `target` and as wide as it (the phone's top bar: the notice then never covers the bar, and a
 * landscape phone keeps it over the work area). With null, or once the element is gone, it goes back to the bottom centre
 * of the page (the screens), above `--notice-bottom`.
 */
export function setNoticeAnchor(target: Anchor) {
  anchorObserver?.disconnect()
  anchorObserver = null
  anchor = target
  if (target && typeof target !== 'function' && typeof ResizeObserver === 'function') { anchorObserver = new ResizeObserver(place); anchorObserver.observe(target) }
  place()
}

/** Put the slot where its anchor is now (a page that moves the anchor, or turns, says so). */
export function placeNotices() { place() }

/** The anchor, if it is in the page and showing (a hidden one has no place to give). */
function anchorEl(): HTMLElement | null {
  const a = typeof anchor === 'function' ? anchor() : anchor
  return a?.isConnected && a.getClientRects().length ? a : null
}

/** An element's box from the page's own origin (the fixed layer's), however the page is turned: layout offsets ignore transforms. */
function layoutBox(target: HTMLElement) {
  let x = 0
  let y = 0
  for (let n: HTMLElement | null = target; n; n = n.offsetParent as HTMLElement | null) {
    if (getComputedStyle(n).position === 'fixed') break
    x += n.offsetLeft
    y += n.offsetTop
  }
  return { x, y, w: target.offsetWidth, h: target.offsetHeight }
}

function place() {
  if (!host) return
  const under = anchorEl()
  if (under) {
    const b = layoutBox(under)
    host.dataset.anchored = ''
    host.style.setProperty('--nt-left', `${b.x}px`)
    host.style.setProperty('--nt-top', `${b.y + b.h + 6}px`)
    host.style.setProperty('--nt-width', `${b.w}px`)
  } else {
    delete host.dataset.anchored
    for (const p of ['--nt-left', '--nt-top', '--nt-width']) host.style.removeProperty(p)
  }
}

// ---- making and ending notices ---------------------------------------------------------------------------------------

/** Show a notice. Returns its id (to dismiss it, or to replace its words). */
export function notify(spec: NoticeSpec): string {
  const id = spec.id ?? `n${++seq}`
  const tone = spec.tone ?? 'info'
  const text = spec.text ?? spec.node?.textContent?.trim() ?? ''
  if (!ensureHost() || !(text || spec.node)) return id
  if (spec.tier === 'ceremony') return ceremony(id, spec, tone)
  let ms = spec.ms ?? noticeDuration(text, tone)
  if (spec.action && spec.ms === undefined) ms = Math.max(ms, ACTION_MIN_MS)
  const entry: Entry = { id, key: `${tone}:${text}`, tier: spec.urgent ? 'state' : 'toast', tone, ms }
  const prior = live.get(id)
  if (prior) { clearTimeout(prior.timer); prior.spec.onClose?.('replaced') }
  live.set(id, { id, spec, entry, el: prior?.el ?? null, cd: null, timer: 0, holds: prior?.holds ?? new Set() })
  const step = offer(queue, entry, now())
  const shown = step.queue.shown?.id === id || step.queue.waiting.some((w) => w.id === id)
  apply(step)
  if (!shown) {
    // The same words were already up (or had just been): the notice that was there stays, and this one is not a new one.
    const l = live.get(id)
    if (l && !l.el) { live.delete(id); spec.onClose?.('dropped') }
  }
  return id
}

function ceremony(id: string, spec: NoticeSpec, tone: NoticeTone): string {
  const prior = live.get(id)
  if (prior) { clearTimeout(prior.timer); prior.spec.onClose?.('replaced') }
  const l: Live = { id, spec, entry: { id, key: id, tier: 'toast', tone, ms: spec.ms ?? 0 }, el: prior?.el ?? null, cd: null, timer: 0, holds: prior?.holds ?? new Set() }
  live.set(id, l)
  present(l)
  changed()
  return id
}

function apply(step: Step) {
  queue = step.queue
  for (const d of step.dropped) {
    const l = live.get(d.id)
    if (!l) continue
    live.delete(d.id)
    l.spec.onClose?.('dropped')
  }
  if (step.displaced) {
    const l = live.get(step.displaced.id)
    if (l) { clearTimeout(l.timer); l.cd = null; if (l.el) { l.el.remove(); l.el = null } }
  }
  if (step.show) {
    const l = live.get(step.show.id)
    if (l) present(l)
  } else if (step.restart && queue.shown) {
    const l = live.get(queue.shown.id)
    if (l) startClock(l, l.entry.ms)
  }
  changed()
}

function present(l: Live) {
  const { spec } = l
  const text = spec.text ?? spec.node?.textContent?.trim() ?? ''
  // (A page may have taken the element out of the document: it is made again.)
  const existing = l.el?.isConnected ? l.el : null
  const fresh = !existing
  const item = existing ?? el('div', spec.className ? `nt-item ${spec.className}` : 'nt-item', { 'data-id': l.id })
  item.dataset.tone = l.entry.tone
  item.dataset.tier = spec.tier ?? 'toast'
  if (spec.passive) item.dataset.passive = ''; else delete item.dataset.passive
  const body = el('span', 'nt-body')
  if (spec.node) body.append(spec.node)
  else body.textContent = text
  const parts: Node[] = [...(spec.icon === false ? [] : [el('span', 'nt-ic', {}, spec.icon ?? GLYPH[l.entry.tone]())]), body]
  if (spec.action) {
    const act = el('button', 'nt-act', { type: 'button' }, spec.action.label)
    act.onclick = () => { spec.action!.run(); if (!spec.action!.keep) close(l.id, 'action') }
    parts.push(act)
  }
  if (spec.closable !== false && !spec.passive) {
    const x = el('button', spec.closeClass ? `nt-x ${spec.closeClass}` : 'nt-x', { type: 'button', 'aria-label': spec.closeLabel ?? 'Dismiss notice' }, svg('M7 7l10 10M17 7 7 17'))
    x.onclick = () => close(l.id, 'dismiss')
    parts.push(x)
  }
  item.replaceChildren(...parts)
  if (fresh) {
    place()
    l.el = item
    // (A notice replaced by one with the same id keeps its element: look the current one up.)
    item.addEventListener('focusin', () => { const c = live.get(l.id); if (c) hold(c, 'focus', true) })
    item.addEventListener('focusout', () => { const c = live.get(l.id); if (c) hold(c, 'focus', false) })
    ;(spec.tier === 'ceremony' ? rail : lane).append(item)
    requestAnimationFrame(() => item.classList.add('in'))
    wire()
  }
  if (spec.announce !== false) say(spec.say ?? text, l.entry.tone === 'bad')
  startClock(l, l.entry.ms)
}

function close(id: string, why: CloseReason) {
  const l = live.get(id)
  if (!l) return
  live.delete(id)
  clearTimeout(l.timer)
  const item = l.el
  l.el = null
  if (item) { item.classList.remove('in'); item.classList.add('out'); setTimeout(() => item.remove(), EXIT_MS) }
  if (l.spec.tier === 'ceremony') changed()
  else apply(finish(queue, id, now()))
  l.spec.onClose?.(why)
}

/** Take a notice away. */
export function dismiss(id: string) { close(id, 'dismiss') }

/** Take every toast away (the person moved on, or the page changed under them). A ceremony folds on its own. */
export function calm() { for (const [id, l] of [...live]) if (l.spec.tier !== 'ceremony') close(id, 'cleared') }

/** How many notices are on screen or waiting. */
export function noticeCount() { return live.size }
export function onNoticesChange(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }
function changed() {
  if (!live.size) unwire()
  for (const fn of [...listeners]) fn()
}

// ---- time ------------------------------------------------------------------------------------------------------------

function startClock(l: Live, ms: number) {
  if (!ms) { clearTimeout(l.timer); l.cd = null; return }
  l.cd = countdown(ms, now())
  if (l.el) {
    // The thin line along its foot runs down with its time, and stops when the time does.
    l.el.style.setProperty('--nt-ms', `${ms}ms`)
    l.el.classList.remove('run')
    void l.el.offsetWidth
    l.el.classList.add('run')
  }
  sync(l)
}

/** Hold the time while anything holds the notice, and let it run again from what is left (and never from less than a moment). */
function sync(l: Live) {
  if (!l.cd) return
  clearTimeout(l.timer)
  if (l.holds.size > 0 || away) {
    l.cd = pause(l.cd, now())
    l.el?.classList.add('held')
    return
  }
  l.el?.classList.remove('held')
  if (l.cd.since === null) l.cd = resume({ left: Math.max(l.cd.left, RESUME_FLOOR_MS), since: null }, now())
  l.timer = window.setTimeout(() => close(l.id, 'time'), remaining(l.cd, now()))
}

function hold(l: Live, why: 'hover' | 'focus' | 'press', on: boolean) {
  if (on === l.holds.has(why)) return
  if (on) l.holds.add(why); else l.holds.delete(why)
  sync(l)
}

// ---- the person's hands ------------------------------------------------------------------------------------------------
// A notice takes the pointer only on its buttons, so a press, a hover and a drag on its body are read from the document.

let press: { id: string; x: number; y: number; pointer: number } | null = null

function over(l: Live, x: number, y: number) {
  const r = l.el?.getBoundingClientRect()
  return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

const onDown = (e: PointerEvent) => {
  for (const l of live.values()) {
    if (!over(l, e.clientX, e.clientY)) continue
    press = { id: l.id, x: e.clientX, y: e.clientY, pointer: e.pointerId }
    hold(l, 'press', true)
    return
  }
}
const onMove = (e: PointerEvent) => {
  if (press && e.pointerId === press.pointer) {
    if (isSwipe(e.clientX - press.x, e.clientY - press.y)) { const id = press.id; release(); close(id, 'swipe') }
    return
  }
  if (e.pointerType !== 'mouse') return
  for (const l of live.values()) hold(l, 'hover', over(l, e.clientX, e.clientY))
}
const onUp = (e: PointerEvent) => { if (press && e.pointerId === press.pointer) release() }
function release() {
  if (!press) return
  const l = live.get(press.id)
  press = null
  if (l) hold(l, 'press', false)
}
const onKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  const t = e.target instanceof Element ? e.target : null
  if (t?.closest('[role=dialog], dialog, .sheet-wrap')) return
  const newest = [...live.values()].reverse().find((l) => l.el && l.spec.closable !== false)
  // One Escape closes one layer: the notice is the topmost, so the key is spent here and the pairing card (which asks
  // `defaultPrevented`) stays.
  if (newest) { e.preventDefault(); close(newest.id, 'dismiss') }
}
const onVisible = () => {
  away = document.visibilityState === 'hidden'
  for (const l of live.values()) sync(l)
}

function wire() {
  if (wired) return
  wired = true
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('pointercancel', onUp, true)
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('visibilitychange', onVisible)
  addEventListener('resize', place)
  onVisible()
}

function unwire() {
  if (!wired) return
  wired = false
  press = null
  document.removeEventListener('pointerdown', onDown, true)
  document.removeEventListener('pointermove', onMove, true)
  document.removeEventListener('pointerup', onUp, true)
  document.removeEventListener('pointercancel', onUp, true)
  document.removeEventListener('keydown', onKey, true)
  document.removeEventListener('visibilitychange', onVisible)
  removeEventListener('resize', place)
}
