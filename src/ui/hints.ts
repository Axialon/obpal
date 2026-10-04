import { setMarkup, html } from './markup'
import { ICONS } from './icons'
import { noticeCount, onNoticesChange } from './kit/notice'
import { countdown, pause, remaining, resume, type Countdown } from './kit/notice-queue'

type Place = 'top' | 'bottom' | 'left' | 'right'
const KEY = 'obpal.hint.'
interface Live { el: HTMLElement; place: () => void; timer: number; cd: Countdown; holds: Set<'hover' | 'focus'>; press: (e: Event) => void }
const live = new Map<string, Live>()
/** One hint at a time: later ones wait here and show when the current one is dismissed. */
const queue: { id: string; show: () => void }[] = []
/** Hints that came due while a notice was up: they show once the notices are gone (the lowest tier gives way). */
const waiting: (() => void)[] = []
const visible = (t: Element | null) => !!t && !!(t as HTMLElement).offsetParent
/** A hint fades by itself: the first of a session after this long, the ones after it after the shorter. */
const FIRST_MS = 8000
const NEXT_MS = 4000
let shownBefore = false
let watching = false

/** Where hints measure: the viewport by default; the controller's own frame while its UI is counter-rotated. */
let frame = {
  rect: (el: Element): { left: number; top: number; width: number; height: number } => el.getBoundingClientRect(),
  size: () => ({ w: innerWidth, h: innerHeight }),
}
export function setHintFrame(f: typeof frame) { frame = f }

const seen = (id: string) => { try { return sessionStorage.getItem(KEY + id) === '1' } catch { return false } }
const markSeen = (id: string) => { try { sessionStorage.setItem(KEY + id, '1') } catch { /* private mode */ } }

/** The fade's clock: it runs while nothing holds the hint (a notice is up, a pointer is on it, focus is in it). */
function sync(id: string) {
  const h = live.get(id)
  if (!h) return
  clearTimeout(h.timer)
  if (h.holds.size || noticeCount() > 0) { h.cd = pause(h.cd, performance.now()); return }
  h.cd = resume(h.cd, performance.now())
  h.timer = window.setTimeout(() => dismissHint(id), remaining(h.cd, performance.now()))
}

/** Notices come and go: hints wait out the ones that are up, and a hint on screen holds its time. */
function watch() {
  if (watching) return
  watching = true
  onNoticesChange(() => {
    for (const id of live.keys()) sync(id)
    if (noticeCount() === 0) for (const show of waiting.splice(0)) show()
  })
}

/**
 * A glass coach-mark that points at an element. Closing it (or calling dismissHint) hides it for the rest of this browser
 * session. Only one shows at a time, and never while a notice is up: it waits. While its element is hidden (another mode,
 * a closed panel) it steps out of the way and comes back with it. It fades by itself after a few seconds (and holds still
 * while it is hovered, has focus, or a notice is up), goes at the first press on what it points at, and takes the pointer
 * only on its own x, so a press on a control it covers reaches the control.
 */
export function hint(id: string, anchor: () => Element | null, text: string, opts: { place?: Place; delay?: number; mount?: HTMLElement; gap?: number } = {}) {
  if (seen(id) || live.has(id)) return
  watch()
  const show = () => {
    const target = anchor()
    if (seen(id) || live.has(id) || !visible(target)) return
    if (noticeCount() > 0) { if (!waiting.includes(show)) waiting.push(show); return }
    if ([...live.values()].some((h) => h.el.parentElement === (opts.mount ?? document.body))) { if (!queue.some((q) => q.id === id)) queue.push({ id, show }); return }
    const place = opts.place ?? 'bottom'
    const el = document.createElement('div')
    el.className = `hint hint-${place}`
    // A note, not a live region: it is help the person can find, and it must not talk over what they are doing.
    el.setAttribute('role', 'note')
    setMarkup(el, html`<span class="hint-text"></span><button class="hint-x" aria-label="Dismiss hint">${ICONS.close}</button>`)
    el.querySelector('.hint-text')!.textContent = text
    el.querySelector('button')!.onclick = (e) => { e.stopPropagation(); dismissHint(id) }
    ;(opts.mount ?? document.body).appendChild(el)
    const position = () => {
      const t = anchor()
      el.classList.toggle('away', !visible(t))
      if (!t || !visible(t)) return
      const r = opts.mount ? t.getBoundingClientRect() : frame.rect(t)
      const b = opts.mount ? el.getBoundingClientRect() : frame.rect(el)
      const { w: vw, h: vh } = opts.mount ? { w: innerWidth, h: innerHeight } : frame.size()
      const gap = opts.gap ?? 12
      let x = 0
      let y = 0
      if (place === 'top' || place === 'bottom') {
        x = Math.min(vw - b.width - 12, Math.max(12, r.left + r.width / 2 - b.width / 2))
        y = place === 'top' ? r.top - b.height - gap : r.top + r.height + gap
        el.style.setProperty('--arrow', `${r.left + r.width / 2 - x}px`)
      } else {
        y = Math.min(vh - b.height - 12, Math.max(12, r.top + r.height / 2 - b.height / 2))
        x = place === 'left' ? r.left - b.width - gap : r.left + r.width + gap
        el.style.setProperty('--arrow', `${r.top + r.height / 2 - y}px`)
      }
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
    position()
    requestAnimationFrame(() => el.classList.add('in'))
    addEventListener('resize', position)
    // Using what it points at is the lesson learned: the first press on it (or inside it) ends the hint.
    const press = (e: Event) => { const t = anchor(); if (t && e.target instanceof Node && t.contains(e.target)) dismissHint(id) }
    document.addEventListener('pointerdown', press, true)
    const holds = new Set<'hover' | 'focus'>()
    const h: Live = { el, place: position, timer: 0, cd: countdown(shownBefore ? NEXT_MS : FIRST_MS, performance.now()), holds, press }
    shownBefore = true
    el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { holds.add('hover'); sync(id) } })
    el.addEventListener('pointerleave', () => { holds.delete('hover'); sync(id) })
    el.addEventListener('focusin', () => { holds.add('focus'); sync(id) })
    el.addEventListener('focusout', () => { holds.delete('focus'); sync(id) })
    live.set(id, h)
    sync(id)
  }
  setTimeout(show, opts.delay ?? 0)
}

/** Hide a hint now and for the rest of the session (e.g. once the user has done the thing it suggests). */
export function dismissHint(id: string) {
  markSeen(id)
  const h = live.get(id)
  if (!h) return
  live.delete(id)
  clearTimeout(h.timer)
  removeEventListener('resize', h.place)
  document.removeEventListener('pointerdown', h.press, true)
  h.el.classList.remove('in')
  setTimeout(() => h.el.remove(), 260)
  const next = queue.shift()
  if (next) setTimeout(next.show, 700)
}

export function repositionHints() {
  for (const h of live.values()) h.place()
}
