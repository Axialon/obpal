/**
 * On a computer, the home page is a real ob.Pal host: a code any phone can scan to paint the hero with light, several
 * at once. It uses the same SDK (@obpal/host) a page of your own would, loaded only once someone is here (the first
 * move of the mouse, a key or a scroll), so a visit that never looks costs no room.
 */
import type { Remote } from '@obpal/host'
import type { ScreenPointer } from '../viewer/pointer'
import { holdForPhone } from '../ui/recover'

export interface Paired { remote: Remote; Pointer: typeof ScreenPointer }

export async function startPairing(slot: HTMLElement): Promise<Paired> {
  const [{ PairingChip, Remote }, { Mode }, { ScreenPointer: Pointer }] = await Promise.all([import('@obpal/host'), import('@obpal/core'), import('../viewer/pointer')])
  const remote = await Remote.create({
    appName: 'ob.Pal',
    // The phone is a tray first (its tilt rolls its marble, as on the phone's own page), then a pointer. Flicking it
    // upward tosses its marble either way.
    layout: { v: 1, tray: [], modes: [Mode.tilt, Mode.point], toss: true },
    seats: 4,
  })
  holdForPhone(remote)
  slot.replaceChildren()
  // The pairing chip as a panel in the hero's own glass: the QR code as wide as the card, the short code under it.
  // 'Use this device' opens the phone controller in a tab: no phone at hand, and it still plays (with its trackpad).
  new PairingChip({ remote, variant: 'panel', parent: slot, label: 'Scan to play', testLink: true })
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
