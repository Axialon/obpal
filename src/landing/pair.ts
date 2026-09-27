/**
 * On a computer, the home page is a real ob.Pal host: a code any phone can scan to paint the hero with light, several
 * at once. It uses the same SDK (@obpal/host) a page of your own would, loaded only once someone is here (the first
 * move of the mouse, a key or a scroll), so a visit that never looks costs no room.
 */
import type { Remote } from '@obpal/host'
import type { ScreenPointer } from '../viewer/pointer'

export interface Paired { remote: Remote; Pointer: typeof ScreenPointer }

export async function startPairing(slot: HTMLElement): Promise<Paired> {
  const [{ Remote }, { Mode }, { ScreenPointer: Pointer }] = await Promise.all([import('@obpal/host'), import('@obpal/core'), import('../viewer/pointer')])
  const remote = await Remote.create({
    appName: 'ob.Pal',
    // Wii-style pointing only: the phone opens straight into it.
    layout: { v: 1, tray: [], modes: [Mode.point] },
    seats: 4,
  })
  slot.replaceChildren()
  // 'This device' opens the phone controller in a tab: no phone at hand, and it still paints (with its trackpad).
  remote.mountPairing(slot, { variant: 'compact', title: 'Scan to play' })
  addEventListener('pagehide', () => remote.destroy(), { once: true })
  return { remote, Pointer }
}

/** Calls `go` once, on the first sign that a person is here. */
export function onPresence(go: () => void) {
  let done = false
  const events = ['pointermove', 'keydown', 'scroll', 'touchstart'] as const
  const once = () => {
    if (done) return
    done = true
    for (const e of events) removeEventListener(e, once)
    go()
  }
  for (const e of events) addEventListener(e, once, { passive: true })
}
