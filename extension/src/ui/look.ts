/**
 * The look of ob.Pal Link's pages (the popup and the options page).
 *
 * The surface and the accent are the Blackboxes family's (src/family), offered as the phone's settings sheet offers
 * them. A pick applies at once and is kept in chrome.storage (the Link's choice, apart from the websites'), with the
 * family's own keys as its cache for the first paint (./lookcache.ts); the other Link page, if it is open, follows it
 * through that cache. Also here: the shared vector logo, the light that follows the mouse across the cards, the radio
 * groups' keys (./radios.ts), and the switch that lets state changes animate only once a page has shown its first
 * real state.
 */
import { family } from '../../../src/family'
import { calmMarks, mountMarks, settleMotion } from '../../../src/ui/icons'
import { applyTheme, initialTheme, themeById, THEMES } from '../../../src/ui/themes'
import { ACCENT_KEY, LOOK_KEY, parseLook, THEME_KEY, type Look } from './lookcache'
import { radioGroup } from './radios'

const LIME = '#c6ff34'
/** A pick, here or in the other page, has been applied: it is newer than the stored look, should that arrive after it. */
let picked = false

/**
 * Apply the remembered surface and accent: the cached look at once (before the page first renders, as its
 * first-paint script did), then the stored one. A pick in the other page reaches this one through the cache: the
 * storage event fires in every page but the one that wrote it.
 */
export function startLook() {
  applyTheme(initialTheme())
  chrome.storage.local.get(LOOK_KEY).then((r) => { if (!picked) wear(parseLook(r[LOOK_KEY])) }, () => {})
  addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== THEME_KEY && e.key !== ACCENT_KEY) return
    picked = true
    applyTheme(themeById(family.getTheme()))
    family.applyAccent()
    syncLook(document)
  })
}

/**
 * Wear the stored look, and cache it (the family keeps what it applies in its own keys). Nothing stored yet (no pick
 * since 1.5): the cached look, if any, stays.
 */
function wear(look: Look | null) {
  if (!look) return
  applyTheme(themeById(look.theme), true)
  family.setAccent(look.accent)
  syncLook(document)
}

/** Store the look in effect (a pick: the family has cached it already). */
function saveLook() {
  picked = true
  const look: Look = { theme: document.documentElement.dataset.theme ?? family.getTheme(), accent: family.getAccent() }
  chrome.storage.local.set({ [LOOK_KEY]: look }).catch(() => {})
}

/**
 * The popup is sized by its content, which Chrome measures (up to 800 × 600), so its layout has a set width. Opened
 * in a tab instead (a test, or someone opening popup.html), it flows with the window: `in-tab` on <html>.
 */
export function markContext() {
  let popup = false
  try {
    popup = chrome.extension.getViews({ type: 'popup' }).includes(window)
  } catch {
    /* not in an extension page */
  }
  // A popup starts out tiny while Chrome measures it; a tab never does.
  document.documentElement.classList.toggle('in-tab', !popup && innerWidth > 200)
}

/**
 * State changes animate (a switch sliding, a card appearing) only after the page has shown its first real state, so
 * opening it shows that state at once rather than animating into it.
 */
export function settle() {
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('settled')))
}

/** The surfaces, each a small window of itself with the accent lit in it, and the accents, as the phone offers them. */
export function lookMarkup(): string {
  const theme = document.documentElement.dataset.theme
  const accent = family.getAccent()
  // ob.Pal's own colour is lime, so the separate Lime choice would repeat it (kept only while it is the one chosen).
  const accents = family.ACCENTS.filter((a) => a.id !== 'lime' || accent === 'lime')
  return `
    <p class="look-k">Surface</p>
    <div class="looks" role="radiogroup" aria-label="Surface">${THEMES.map((t) =>
      `<button class="look" type="button" role="radio" data-theme="${t.id}" aria-checked="${t.id === theme}" style="--pv-page:${t.base};--pv-surface:${t.surface}"><i aria-hidden="true"></i><span>${t.name}</span></button>`).join('')}</div>
    <p class="look-k">Colour</p>
    <div class="accents" role="radiogroup" aria-label="Colour">${accents.map((a) => {
      const name = a.id === 'product' ? 'ob.Pal lime (default)' : a.name
      return `<button class="bb-accent${a.id === 'product' ? ' product' : ''}" type="button" role="radio" data-accent="${a.id}" aria-checked="${a.id === accent}" aria-label="${name}" title="${name}" style="--sw:${a.color ?? LIME}">${family.icons.check}</button>`
    }).join('')}</div>`
}

/** Fill `root` with the look choices (radio groups the arrow keys move through) and apply a pick at once. */
export function mountLook(root: HTMLElement, onPick?: () => void) {
  root.innerHTML = lookMarkup()
  for (const group of root.querySelectorAll<HTMLElement>('[role=radiogroup]')) radioGroup(group)
  root.addEventListener('click', (e) => {
    const target = e.target as Element
    const surface = target.closest<HTMLElement>('.look[data-theme]')
    const accent = target.closest<HTMLElement>('.accents [data-accent]')
    if (surface && root.contains(surface)) applyTheme(themeById(surface.dataset.theme), true)
    else if (accent && root.contains(accent)) family.setAccent(accent.dataset.accent!)
    else return
    syncLook(document)
    saveLook()
    onPick?.()
  })
}

/** Mark the surface and accent in effect in every look picker under `root`. */
export function syncLook(root: ParentNode) {
  const theme = document.documentElement.dataset.theme
  const accent = family.getAccent()
  for (const b of root.querySelectorAll<HTMLElement>('.look[data-theme]')) b.setAttribute('aria-checked', String(b.dataset.theme === theme))
  for (const b of root.querySelectorAll<HTMLElement>('.accents [data-accent]')) b.setAttribute('aria-checked', String(b.dataset.accent === accent))
}

/**
 * Mount the shared vector identity. `orbits` remains compatible with surfaces that previously settled the logo.
 */
export function mountLogo(root: ParentNode = document, orbits?: number) {
  mountMarks(root)
  settleMotion(root)
  if (orbits !== undefined) calmMarks(root, orbits)
}

/** A light follows the mouse across the cards, and their edges catch it (a mouse only, as on the home page). */
export function lightCards(selector = '.card') {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return
  let raf = 0
  let at: PointerEvent | null = null
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return
    at = e
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      const card = (at?.target as Element | null)?.closest?.<HTMLElement>(selector)
      if (!card || !at) return
      const r = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${(at.clientX - r.left).toFixed(0)}px`)
      card.style.setProperty('--my', `${(at.clientY - r.top).toFixed(0)}px`)
    })
  }, { passive: true })
}
