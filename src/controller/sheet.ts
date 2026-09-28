/**
 * A bottom sheet's ways out, the way a phone's own sheets work: a tap above it, a swipe down (from its top edge, or
 * from anywhere while its content is scrolled to the top), the phone's Back, and Esc. The sheet itself fits the
 * visible screen (its content scrolls, clear of the browser's own bars: controller.css).
 */
import { toUi } from './uiframe'

/** Pulled down this far (px), or flung down this fast (px/ms), it closes; less, and it springs back. */
const CLOSE_PX = 90
const FLING = 0.55

/**
 * Whether the history entry now is the one pushed with `mark`. history.state is a copy of what was pushed, never the
 * object itself, so the mark is compared by its values.
 */
export function atMark(mark: Readonly<Record<string, number>> | null): boolean {
  const s = history.state as Record<string, unknown> | null
  return !!mark && !!s && typeof s === 'object' && Object.entries(mark).every(([k, v]) => s[k] === v)
}

/**
 * A layer closing so that another opens in the same tap (Settings' camera opening the scanner) leaves its Back step
 * to that one, which takes it over rather than adding its own: no step back and then forward again, which a browser
 * takes its time over, while the new layer is already listening for Back. If nothing takes it by the next task, the
 * step comes off.
 */
let handed = false
export function handStep() {
  handed = true
  setTimeout(() => { if (handed) { handed = false; history.back() } })
}

/**
 * Wire `wrap` (the .sheet-wrap holding a .sheet) to close through `close`. Returns what the sheet's own close must
 * call once: it takes the Back step off the history if the sheet didn't close through Back, or with `handOver` leaves
 * it to the layer opening next (handStep).
 */
export function sheetExits(wrap: HTMLElement, close: () => void): (handOver?: boolean) => void {
  const sheet = wrap.querySelector<HTMLElement>('.sheet')!
  let done = false
  const shut = () => { if (!done) close() }
  wrap.addEventListener('click', (e) => { if (e.target === wrap) shut() })
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') shut() }
  addEventListener('keydown', onKey)

  // Back closes the sheet instead of leaving the controller: its own step, or the one a closing layer handed it.
  const mark = { obpalSheet: Math.random() }
  if (handed) { handed = false; history.replaceState(mark, '') } else history.pushState(mark, '')
  // Back to its own step (a layer over it closed) keeps it open; any further back closes it.
  const onPop = () => { if (atMark(mark)) return; popped = true; shut() }
  let popped = false
  addEventListener('popstate', onPop)

  // A swipe down: the sheet follows the finger, then goes or springs back.
  let pull: { y: number; t: number; dy: number; v: number; on: boolean } | null = null
  const slider = (t: EventTarget | null) => !!(t as Element | null)?.closest?.('input[type=range], .bb-range, .pick-grid')
  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || slider(e.target)) { pull = null; return }
    const top = !!(e.target as Element).closest('.grip, .sheet-head, .picker-head')
    // From the top edge always; from inside only while there's nothing above to scroll back to.
    if (!top && sheet.scrollTop > 0 && !(e.target as Element).closest('.picker-head')) { pull = null; return }
    pull = { y: toUi(e.touches[0].clientX, e.touches[0].clientY).y, t: e.timeStamp, dy: 0, v: 0, on: false }
  }, { passive: true })
  sheet.addEventListener('touchmove', (e) => {
    if (!pull) return
    const y = toUi(e.touches[0].clientX, e.touches[0].clientY).y
    const dy = y - pull.y
    const dt = Math.max(1, e.timeStamp - pull.t)
    pull.v = pull.v * 0.5 + ((dy - pull.dy) / dt) * 0.5
    pull.dy = dy
    pull.t = e.timeStamp
    if (!pull.on && dy > 8) { pull.on = true; sheet.style.transition = 'none' }
    if (!pull.on) return
    if (e.cancelable) e.preventDefault()
    sheet.style.transform = `translateY(${Math.max(0, dy)}px)`
  }, { passive: false })
  const release = () => {
    const p = pull
    pull = null
    if (!p?.on) return
    sheet.style.transition = ''
    if (p.dy > CLOSE_PX || (p.dy > 24 && p.v > FLING)) {
      sheet.style.transform = `translateY(${sheet.offsetHeight}px)`
      shut()
    } else sheet.style.transform = ''
  }
  sheet.addEventListener('touchend', release)
  sheet.addEventListener('touchcancel', release)

  return (handOver = false) => {
    if (done) return
    done = true
    removeEventListener('keydown', onKey)
    removeEventListener('popstate', onPop)
    if (popped || !atMark(mark)) return
    if (handOver) handStep()
    else history.back()
  }
}
