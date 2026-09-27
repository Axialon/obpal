/**
 * Where the look (the surface and the accent, ./look.ts) is kept. chrome.storage.local "look" is the truth: it
 * survives what clearing browsing data takes from a page's own storage. The family's own keys in the page's
 * localStorage (and its cookie), which the family reads synchronously, are its cache: a page can wear the last look
 * before it first paints (./first-paint.ts), long before chrome.storage could answer. Every change updates both.
 * Nothing here touches the family itself, so the first-paint script stays a few hundred bytes.
 */

/** chrome.storage.local key of the look. */
export const LOOK_KEY = 'look'
/** The family's keys (src/family/family.js): the surface (also a cookie of that name) and the accent. */
export const THEME_KEY = 'bb_theme'
export const ACCENT_KEY = 'bb_accent'
/** The family's default surface, worn while nothing is cached (so the first paint matches what the family applies). */
const DEFAULT_THEME = 'carbon'

export interface Look {
  /** A family surface id (carbon, navy, violet, wine, onyx, light). */
  theme: string
  /** 'product' (ob.Pal's lime) or a family accent id. */
  accent: string
}

const ID = /^[a-z]{1,16}$/
const isId = (x: unknown): x is string => typeof x === 'string' && ID.test(x)

/** A stored look, or null. Ids are checked for shape only: the family falls back to its defaults for one it doesn't know. */
export function parseLook(x: unknown): Look | null {
  if (typeof x !== 'object' || x === null) return null
  const { theme, accent } = x as Record<string, unknown>
  return isId(theme) && isId(accent) ? { theme, accent } : null
}

/**
 * The cached look as the attributes the family and ./look.ts set on <html>, for the first paint: the surface (the
 * cookie first, as the family reads it, then localStorage), ob.Pal as the product, and a chosen accent.
 */
export function wearCachedLook(root: HTMLElement, cookie: string, storage: Pick<Storage, 'getItem'> | null) {
  const read = (key: string) => {
    try {
      return storage?.getItem(key) ?? null
    } catch {
      return null
    }
  }
  const cached = new RegExp(`(?:^|;\\s*)${THEME_KEY}=([a-z]+)`).exec(cookie)?.[1] ?? read(THEME_KEY)
  const theme = isId(cached) ? cached : DEFAULT_THEME
  root.setAttribute('data-bb-product', 'obpal')
  root.setAttribute('data-bb-theme', theme)
  root.dataset.theme = theme
  const accent = read(ACCENT_KEY)
  if (isId(accent) && accent !== 'product') root.setAttribute('data-bb-accent', accent)
}
