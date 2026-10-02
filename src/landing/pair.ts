/**
 * On a computer, the home page is a real ob.Pal host: a code any phone can scan to paint the hero with light, several
 * at once. It uses the same SDK (@obpal/host) a page of your own would, loaded only once someone is here (the first
 * move of the mouse, a key or a scroll), so a visit that never looks costs no room.
 */
import type { Remote } from '@obpal/host'
import type { ScreenPointer } from '../viewer/pointer'
import { holdForPhone } from '../ui/recover'
import { ICONS } from '../ui/icons'
import { setMarkup } from '../ui/markup'

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
  const chip = new PairingChip({ remote, variant: 'panel', parent: slot, label: 'Scan to play', testLink: true })
  // Home owns the frame. Keep the SDK's other chips unchanged, with one evenly spaced row under this QR.
  const root = chip.el.shadowRoot!
  const styles = `
    .wrap[data-variant=panel] .card { width: 100%; box-sizing: border-box; }
    .wrap[data-variant=panel] .qr { width: 100%; margin: 0; align-self: center; }
    .wrap[data-variant=panel] .side { width: 100%; display: grid; grid-template-columns: repeat(5, 1fr); gap: 0; align-items: start; min-height: 44px; }
    .wrap[data-variant=panel] .pair-icons { position: static; display: contents; color: var(--bb-accent-text, var(--a)); }
    .pair-icons > span { display: grid; place-items: center; height: 44px; }
    .pair-icons .ic, .scan-cues .ic { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .wrap[data-variant=panel] .scan-cues { align-self: start; width: 100%; max-width: none; color: var(--bb-accent-text, var(--a)); }
    .scan-cues summary { display: grid; place-items: center; width: 100%; min-width: 0; height: 44px; padding: 0; list-style: none; }
    .scan-cues summary::-webkit-details-marker { display: none; }
    .scan-cues[open] { grid-column: 1 / -1; color: var(--ink); }
    .scan-cues[open] summary { width: 20%; margin-left: auto; color: var(--bb-accent-text, var(--a)); }
    .wrap[data-variant=panel] .side > .seal-action { position: static; grid-column: 1 / -1; }
  `
  if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(styles)
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
  } else {
    const style = document.createElement('style')
    style.textContent = styles
    root.appendChild(style)
  }
  const cues = root.querySelectorAll('.pair-icons > span')
  for (const [i, name] of ['camera', 'phone', '', 'lock'].entries()) if (name && cues[i]) setMarkup(cues[i], ICONS[name])
  // The third existing cue means no account, so retain its crossed-person glyph and tooltip.
  const account = cues[2]?.querySelector('svg')
  account?.classList.replace('i', 'ic')
  const info = root.querySelector('summary')
  if (info) { setMarkup(info, ICONS.help); info.setAttribute('title', 'Pairing details') }
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
