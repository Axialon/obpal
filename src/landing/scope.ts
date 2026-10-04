/**
 * Where the home page's marble field plays, on a phone.
 *
 * The whole-page field (marbles that ride the page as it scrolls, lift, land and dock in the marbles toggle, and roll
 * among the lower sections' cards and headings) is not good enough on a phone yet. Until the phone experience is
 * refined, a phone plays only in the hero, the first screen: its canvas is part of the page and scrolls away with the
 * hero, and the field sleeps once the hero is out of view. Nothing of the whole-page behaviour is removed; it runs
 * wherever the scope is 'page'.
 */

/** 'hero': only the first screen. 'page': the whole page (the field's full behaviour). */
export type FieldScope = 'hero' | 'page'

/**
 * TEMPORARY PRODUCT DECISION: the scope phones get. Set this to 'page' to give phones the whole-page field again
 * (scroll-ride, lift, land, dock, and the lower sections' colliders), once the phone experience is refined.
 * Computers and tablets always play on the whole page, whatever this says.
 */
export const PHONE_FIELD_SCOPE: FieldScope = 'hero'

/**
 * The scope for this visit: 'page' for anything but a phone, else PHONE_FIELD_SCOPE. `?fieldscope=page` (or `hero`)
 * in the address asks for the other on a phone, to try the whole-page field and for the tests that cover it.
 */
export function fieldScope(phone: boolean, search = ''): FieldScope {
  if (!phone) return 'page'
  const asked = new URLSearchParams(search).get('fieldscope')
  return asked === 'page' || asked === 'hero' ? asked : PHONE_FIELD_SCOPE
}

/**
 * Whether any of the hero's canvas is still in view: its top is the page's top, `stage` px tall, and the page's bar
 * (`bar` px) covers what's under it.
 */
export function heroInView(scroll: number, stage: number, bar: number): boolean {
  return scroll + bar < stage
}

/** How far below the canvas's bottom a fixed control stops (px). */
const CLEAR = 80

/**
 * Where a control fixed to the screen (its top `top` px down it) is on the hero's canvas, which scrolls with the page:
 * `scroll` px further down. Once the control is clear of the canvas's bottom it stays there, so it stops moving.
 */
export function stageTop(top: number, scroll: number, stage: number): number {
  return top + Math.min(Math.max(0, scroll), Math.max(0, stage - top) + CLEAR)
}
