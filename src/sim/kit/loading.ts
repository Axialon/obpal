/**
 * The loading state of a sim's device area: one glass pill with the shared dots (#sim-load, in the page's HTML and
 * styled in sim.css), shown from the first paint until every rig the page waits for is ready to appear. It is
 * `hidden` in the HTML and shown by the page's early script (./early.ts) on pages that have a mesh, so a sim without
 * one never shows it. It comes in after a short delay, so a mesh that is there at once never shows it at all.
 * Nothing here needs three.js or the rest of the kit.
 */

/** Rigs held back from view, and whether the page has yet to make its first hold. */
import { dotLoading } from '../../ui/kit/loading'

let holding = 0
let expecting = false
let leaving: ReturnType<typeof setTimeout> | undefined
let expectation: ReturnType<typeof setTimeout> | undefined
let stopped = false

/** The pill, where the page has one (not in a test's stand-in for a document). */
const element = () => typeof document === 'undefined' || typeof document.getElementById !== 'function' ? null : document.getElementById('sim-load')

function update() {
  const el = element()
  if (!el) return
  dotLoading(el, !stopped && (expecting || holding > 0), 'Preparing the scene', 48)
  if (stopped) { el.hidden = true; el.classList.remove('on'); return }
  if (expecting || holding > 0) {
    clearTimeout(leaving)
    if (!el.hidden && el.classList.contains('on')) return
    el.hidden = false
    // Laid out once as it is, so the delay before it fades in is a transition.
    void el.offsetWidth
    el.classList.add('on')
  } else if (!el.hidden) {
    el.classList.remove('on')
    leaving = setTimeout(() => { el.hidden = true }, 260)
  }
}

/**
 * The page will hold a rig back shortly (its early script calls this): the pill shows already, while the scene is still
 * on its way. If nothing holds within `patience` ms (the page never got that far), it goes.
 */
export function expectRig(patience = 15000) {
  if (stopped) return
  clearTimeout(expectation)
  expecting = true
  update()
  expectation = setTimeout(() => { expecting = false; update() }, patience)
}

/** A terminal start failure replaces the pill; late downloads cannot bring its busy state back. */
export function stopLoading() {
  stopped = true
  expecting = false
  holding = 0
  clearTimeout(expectation)
  clearTimeout(leaving)
  update()
}

/** Whether the pill is up: rigs are held, or the page is about to hold one. */
export const loadingNow = () => expecting || holding > 0

/** A rig is held back; the pill shows until every held rig has been let go. */
export function beginLoading() {
  if (stopped) return
  expecting = false
  holding++
  update()
}

/** A held rig is shown, or gone. */
export function endLoading() {
  holding = Math.max(0, holding - 1)
  update()
}

/** Where the pill stands across the page: the middle of what the panel leaves free (CSS px from the left edge). */
export function placeLoading(x: number) {
  if (typeof document !== 'undefined') document.documentElement?.style.setProperty('--load-x', `${Math.round(x)}px`)
}

/** Whether things should move in, not just appear: not for a visitor who asked for less motion, nor while the contact and surface tests measure. */
export function motionAllowed(): boolean {
  if (typeof matchMedia !== 'function' || typeof requestAnimationFrame !== 'function' || typeof location === 'undefined') return false
  return !matchMedia('(prefers-reduced-motion: reduce)').matches && !/[?&]test=(?:contact|vr)\b/.test(location.search)
}
