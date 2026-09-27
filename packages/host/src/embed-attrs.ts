/**
 * <obpal-remote>'s attributes, read as a layout and chip options (./element.ts). Pure, so the element, its tests and
 * any page read them the same way.
 */
import { controllerOf, CONTROLLERS, isControllerId, Mode, type Layout, type ModeId } from '@obpal/core'
import { DEFAULT_LAYOUT } from './remote'

/** The mode names `modes` takes beside controller ids. */
const MODE_NAMES = new Map<string, ModeId>(Object.entries(Mode) as [string, ModeId][])

/**
 * The `modes` attribute: mode names (point, hold, tilt, pad, gamepad, track) and catalogue controller ids (face.wii,
 * face.gamepad, …; CATALOGUE §9.1), in order, separated by spaces or commas. Each mode brings its controller and each
 * controller its modes, so the layout says both: `modes` for phones that predate controllers, `controllers` for the
 * rest (the first opens). Null when the attribute is absent or empty.
 */
export function parseModes(text: string | null | undefined): { modes: ModeId[]; controllers: string[]; unknown: string[] } | null {
  const tokens = (text ?? '').split(/[\s,]+/).filter(Boolean)
  if (!tokens.length) return null
  const modes: ModeId[] = []
  const controllers: string[] = []
  const unknown: string[] = []
  const add = <T>(list: T[], x: T) => { if (!list.includes(x)) list.push(x) }
  for (const token of tokens) {
    const t = token.toLowerCase()
    const m = MODE_NAMES.get(t)
    if (m !== undefined) {
      add(modes, m)
      const c = controllerOf(m)
      if (c) add(controllers, c)
    } else if (isControllerId(t)) {
      add(controllers, t)
      for (const cm of CONTROLLERS[t].modes) add(modes, cm)
    } else unknown.push(token)
  }
  return { modes, controllers, unknown }
}

/**
 * The layout the element offers: `modes` and `profile` from its attributes over the SDK's default modes, then the
 * page's own `layout` property (tray, keys, toss and the rest), which wins where both say something.
 */
export function embedLayout(attrs: { modes?: string | null; profile?: string | null }, extra: Partial<Layout> = {}): Layout {
  const parsed = parseModes(attrs.modes)
  const profile = attrs.profile?.trim()
  return {
    ...(parsed ? { modes: parsed.modes, controllers: parsed.controllers } : { modes: [...(DEFAULT_LAYOUT.modes ?? [])] }),
    ...(profile ? { profile } : {}),
    ...extra,
    v: 1,
    tray: extra.tray ?? [],
  }
}

/** `seats`: how many devices at once, 1 (a new one takes over) to 8 (a shared scene). */
export function parseSeats(text: string | null | undefined): number {
  const n = Math.floor(Number(text))
  return Number.isFinite(n) ? Math.max(1, Math.min(8, n)) : 1
}

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'inline'
const CORNERS: readonly Corner[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'inline']

/** `corner`: where the chip sits; `inline` leaves it where the element is. */
export function parseCorner(text: string | null | undefined): Corner {
  const t = (text ?? '').trim().toLowerCase()
  return (CORNERS as readonly string[]).includes(t) ? (t as Corner) : 'bottom-right'
}

/** `scheme`: the chip's colours, following the page (auto) or fixed. */
export function parseScheme(text: string | null | undefined): 'auto' | 'light' | 'dark' {
  const t = (text ?? '').trim().toLowerCase()
  return t === 'light' || t === 'dark' ? t : 'auto'
}

/** A yes-or-no attribute: absent is the default; present is yes unless it says false, off, no or 0. */
export function parseFlag(text: string | null | undefined, absent: boolean): boolean {
  if (text == null) return absent
  return !/^(false|off|no|0)$/i.test(text.trim())
}
