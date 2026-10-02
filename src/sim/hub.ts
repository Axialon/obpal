/**
 * The sim catalogue (/sim/): a card for each sim with a live preview, the controllers that suit it (the best one lit)
 * and Try it, which opens the sim with its pairing chip. A sidebar browses by collection and category and filters by
 * controller and search: docked beside the cards on a computer (or folded to its icon rail, as it's remembered), a
 * rail that opens as a drawer on a tablet, and a bottom sheet on a phone (../ui/kit/sidebar.ts). ?category=, ?face=
 * (wii or face.wii) and ?q= open it filtered, so the control catalogue can link a controller to the sims that take it,
 * and the address keeps the view as it changes.
 */
import '../landing/site'
import { CONTROLLERS, type ControllerId } from '@obpal/core'
import { html, setMarkup } from '../ui/markup'
import { ICONS } from '../ui/icons'
import { initTips } from '../ui/tips'
import { fitControlInk } from '../ui/kit/ink'
import { GlassSelect, type SelectItem } from '../ui/kit/select'
import { Segmented, type SegmentItem } from '../ui/kit/segmented'
import { Sidebar, type SidebarMode } from '../ui/kit/sidebar'
import { Readout } from '../ui/kit/readout'
import { CATEGORIES, filterSims, filtersFrom, filtersUrl, PROPOSED, SIMS, type CollectionId, type SimCard, type SimFilters } from './catalogue'
import { FACES, faceGlyph, faceShort } from './faces'
import { mountPreviews, type PreviewSlot } from './previews'
// After the kit's own styles (imported with its parts above), so the catalogue's can build on them.
import '../styles/sims.css'

const $ = (id: string) => document.getElementById(id)!
const motion = matchMedia('(prefers-reduced-motion: reduce)')
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** The collections and categories, in the sidebar's order, each with its glyph. */
const COLLECTIONS: { id: CollectionId | null; name: string }[] = [{ id: null, name: 'All' }, { id: 'featured', name: 'Featured' }, { id: 'new', name: 'New' }]
const GLYPH: Record<string, string> = {
  '': 'models', featured: 'star', new: 'glow', robotics: 'arm', vehicles: 'car', flying: 'drone', home: 'guide',
  'camera-stage': 'camera', games: 'stick', industrial: 'factory', music: 'note', 'space-science': 'orbit',
}
const glyph = (id: CollectionId | null | undefined) => ICONS[GLYPH[id ?? '']] ?? ''
const nameOf = (id: CollectionId | null) => [...COLLECTIONS, ...CATEGORIES].find((c) => c.id === id)?.name ?? 'All'

/** A controller badge: its glyph and short name, the whole line on hover. */
function badge(c: ControllerId, card: SimCard, first: boolean) {
  const li = document.createElement('li')
  li.dataset.face = c
  if (first) li.className = 'first'
  li.title = [CONTROLLERS[c].name, card.how?.[c]].filter(Boolean).join(' · ')
  setMarkup(li, html`${faceGlyph(c)}<span>${faceShort(c)}</span>`)
  return li
}

function cardOf(card: SimCard): { el: HTMLElement; slot: PreviewSlot | null } {
  const el = document.createElement('article')
  el.className = 'dcard glass'
  el.dataset.id = card.id
  el.dataset.faces = card.controllers.join(' ')
  const stage = document.createElement('a')
  stage.className = 'dcard-stage'
  stage.href = card.href!
  stage.tabIndex = -1
  stage.setAttribute('aria-hidden', 'true')
  setMarkup(stage, html`<span class="dcard-ph">${faceGlyph(card.controllers[0])}</span><canvas></canvas><span class="dcard-kind">${glyph(card.category)}<span>${CATEGORIES.find((c) => c.id === card.category)?.name ?? card.kind}</span></span>`)
  const body = document.createElement('div')
  body.className = 'dcard-body'
  setMarkup(body, html`<h2>${card.name}</h2><p>${card.blurb}</p><ul class="dcard-faces" aria-label="Controllers that suit it"></ul><div class="dcard-foot"><a class="dcard-go" href="${card.href!}" aria-label="Try the ${card.name.toLowerCase()}"><span>Try it</span>${ICONS['arrow-right']}</a></div>`)
  const faces = body.querySelector('ul')!
  if (card.id !== 'viewer') {
    const local = document.createElement('a'); local.className = 'dcard-local kit-action'; local.textContent = 'Play here'
    const href = new URL(card.href!, location.origin); href.searchParams.set('local', matchMedia('(pointer: coarse)').matches ? 'phone' : 'here')
    local.href = href.pathname + href.search; body.querySelector('.dcard-foot')!.append(local)
  }
  card.controllers.forEach((c, i) => faces.appendChild(badge(c, card, i === 0)))
  el.append(stage, body)
  if (!card.preview) return { el, slot: null }
  return { el, slot: { canvas: stage.querySelector('canvas')!, load: card.preview } }
}

function soonOf(card: SimCard) {
  const el = document.createElement('article')
  el.className = 'dsoon'
  el.dataset.faces = card.controllers.join(' ')
  setMarkup(el, html`<span class="dsoon-ic">${ICONS[card.glyph ?? 'phone'] ?? ''}</span><div><b>${card.name}</b><p>${card.blurb}</p><ul class="dcard-faces"></ul></div>`)
  const faces = el.querySelector('ul')!
  card.controllers.forEach((c, i) => faces.appendChild(badge(c, card, i === 0)))
  return el
}

// ---- the cards ----

const grid = $('sims')
const made = SIMS.map(cardOf)
motion.addEventListener('change', () => {
  if (motion.matches) made.forEach(({ el }) => el.getAnimations().forEach(a => a.cancel()))
})
grid.replaceChildren(...made.map((m) => m.el))
$('soon').replaceChildren(...PROPOSED.map(soonOf))
$('soon').closest<HTMLElement>('.sims-next')!.hidden = PROPOSED.length === 0
const previews = mountPreviews(made.flatMap((m) => (m.slot ? [m.slot] : [])))

// ---- the sidebar: collections, categories and the controller ----

let filters = filtersFrom(location.search)
const search = $('search') as HTMLInputElement
const searchBox = $('sims-search')

/** A collection or category in the sidebar: its glyph in a ring, its name, and how many sims it holds in this view. */
function sideItem(c: { id: CollectionId | null; name: string }) {
  const li = document.createElement('li')
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'kit-side-item sims-category'
  b.dataset.category = c.id ?? ''
  b.dataset.railTip = c.name
  setMarkup(b, html`<span class="kit-side-ic" aria-hidden="true">${glyph(c.id)}</span><span class="kit-side-text">${c.name}</span><span class="kit-side-n"></span>`)
  b.onclick = () => setFilters({ ...filters, category: c.id })
  li.append(b)
  return li
}
$('collections').replaceChildren(...COLLECTIONS.map(sideItem))
$('categories').replaceChildren(...CATEGORIES.map(sideItem))

/** How many sims each controller leaves in this view (the category and search as they are). */
const faceCount = (id: ControllerId | null) => filterSims(SIMS, { ...filters, face: id }).length
/** A controller with no sims here can't be chosen, unless it's the one chosen (or All). */
const faceOff = (id: ControllerId | null, n: number) => n === 0 && id !== filters.face && id !== null
const faceItems = (): SelectItem[] => [null, ...FACES].map((id) => {
  const n = faceCount(id)
  return { value: id ?? '', label: id ? faceShort(id) : 'All controllers', icon: id ? faceGlyph(id) : ICONS.phone, badge: n, disabled: faceOff(id, n) }
})
const faceTiles = (): SegmentItem[] => [null, ...FACES].map((id) => {
  const n = faceCount(id)
  return { value: id ?? '', label: id ? faceShort(id) : 'All', icon: id ? faceGlyph(id) : ICONS.phone, badge: n, disabled: faceOff(id, n) }
})
// A glass select beside the cards; tiles in the phone's sheet, where every controller shows at once.
const controller = new GlassSelect({ label: 'Controller', id: 'controller-filter', className: 'sims-controller-select', items: faceItems(), value: filters.face ?? '', onChange: (v) => setFace((v || null) as ControllerId | null) })
const tiles = new Segmented({ label: 'Controller', className: 'sims-controller-tiles', tiles: true, items: faceTiles(), value: filters.face ?? '', onChange: (v) => setFace((v || null) as ControllerId | null) })
$('controller-slot').append(controller.button, tiles.el)

setMarkup($('side-toggle'), html`${ICONS.sidebar}`)
setMarkup($('rail-search'), html`${ICONS.search}`)
setMarkup($('sheet-close'), html`${ICONS.close}`)
setMarkup($('sheet-done'), html`<span id="sheet-done-text">Show sims</span>${ICONS['arrow-right']}`)

/** Search sits in the sidebar when it's docked, above the cards otherwise. */
function placeSearch(mode: SidebarMode) {
  const slot = $(mode === 'docked' ? 'side-search-slot' : 'bar-search-slot')
  if (searchBox.parentElement === slot) return
  const focused = document.activeElement === search
  slot.append(searchBox)
  if (focused) search.focus({ preventScroll: true })
}

const side = new Sidebar($('sims-side'), {
  key: 'obpal.sims.sidebar',
  label: 'Filters',
  toggles: [$('side-toggle'), $('filters-open')],
  sheetHandle: document.querySelector<HTMLElement>('.sims-sheet-head'),
  onChange: (mode) => { placeSearch(mode); document.documentElement.dataset.sims = mode; previews.refresh() },
})
placeSearch(side.mode)
document.documentElement.dataset.sims = side.mode
$('sheet-close').onclick = () => side.collapse()
$('sheet-done').onclick = () => side.collapse()
$('rail-search').onclick = () => { side.expand(); requestAnimationFrame(() => search.focus()) }
// The sidebar's width changes the cards' columns: previews redraw at their new size once it has.
$('sims-side').addEventListener('transitionend', (e) => { if (e.propertyName === 'width') previews.refresh() })

// ---- the view: the address, the counts, the chips, the cards ----

const count = new Readout({ value: '00', pitch: 4 })
$('count-readout').append(count.el)

/** An active filter as a chip that takes it away. */
function chip(icon: string, text: string, label: string, clear: () => void) {
  const c = document.createElement('span')
  c.className = 'kit-chip'
  setMarkup(c, html`${icon}<span>${text}</span><button type="button" aria-label="${label}">${ICONS.close}</button>`)
  c.querySelector('button')!.onclick = clear
  return c
}

/** Keep the chosen category in sight in the sidebar, which scrolls on a short screen, without moving the page. */
function revealCategory() {
  const body = $('sims-side').querySelector<HTMLElement>('.kit-side-body')!
  const b = body.querySelector<HTMLElement>('.sims-category[aria-pressed="true"]')
  if (!b) return
  const top = b.offsetTop - body.offsetTop, bottom = top + b.offsetHeight
  if (top < body.scrollTop) body.scrollTop = top - 8
  else if (bottom > body.scrollTop + body.clientHeight) body.scrollTop = bottom - body.clientHeight + 8
}

/** Show the sims `next` suits, moving the cards that stay to their new places rather than jumping (FLIP). */
function setFilters(next: SimFilters, animate = true, navigation: 'push' | 'replace' | 'none' = 'push') {
  filters = next
  const { face, category, q } = filters
  const url = filtersUrl(new URL(location.href), filters)
  if (navigation !== 'none' && url.href !== location.href) history[navigation === 'push' ? 'pushState' : 'replaceState'](null, '', url)
  if (search.value.trim() !== q) search.value = q
  for (const b of document.querySelectorAll<HTMLElement>('.sims-category')) {
    const id = (b.dataset.category || null) as CollectionId | null
    const n = filterSims(SIMS, { ...filters, category: id }).length
    b.setAttribute('aria-pressed', String(id === category))
    b.querySelector('.kit-side-n')!.textContent = String(n)
    b.classList.toggle('kit-empty', n === 0)
  }
  controller.setItems(faceItems(), face ?? '')
  tiles.setItems(faceTiles(), face ?? '')
  $('controller-slot').classList.toggle('on', !!face)

  const cards = [...grid.children] as HTMLElement[]
  const before = new Map(cards.map((c) => [c, c.hidden ? null : c.getBoundingClientRect()]))
  const matches = new Set(filterSims(SIMS, filters).map(c => c.id))
  for (const c of cards) {
    c.hidden = !matches.has(c.dataset.id!)
    c.querySelectorAll<HTMLElement>('.dcard-faces li').forEach((li) => li.classList.toggle('match', li.dataset.face === face))
  }
  document.querySelectorAll<HTMLElement>('.dsoon').forEach((c) => {
    c.classList.toggle('dim', !!face && !c.dataset.faces!.split(' ').includes(face))
    c.querySelectorAll<HTMLElement>('.dcard-faces li').forEach((li) => li.classList.toggle('match', li.dataset.face === face))
  })
  $('none').hidden = cards.some((c) => !c.hidden)

  const n = matches.size, sims = `${n} ${n === 1 ? 'sim' : 'sims'}`
  $('result-count').textContent = sims
  count.value = String(n).padStart(2, '0')
  $('view-title').textContent = category ? nameOf(category) : 'All sims'
  const chips: HTMLElement[] = []
  if (category) chips.push(chip(glyph(category), nameOf(category), `Show every category`, () => setFilters({ ...filters, category: null })))
  if (face) chips.push(chip(faceGlyph(face), faceShort(face), `Show sims for any controller`, () => setFilters({ ...filters, face: null })))
  if (q) chips.push(chip(ICONS.search, `“${q}”`, 'Clear the search', () => setFilters({ ...filters, q: '' })))
  $('chip-list').replaceChildren(...chips)
  $('chips').hidden = !chips.length
  const set = (category ? 1 : 0) + (face ? 1 : 0)
  $('filters-n').hidden = !set
  $('filters-n').textContent = String(set)
  $('sheet-done-text').textContent = n ? `Show ${sims}` : 'No sims match'
  $('sheet-clear').toggleAttribute('disabled', !category && !face && !q)
  revealCategory()
  previews.refresh()
  if (!animate || motion.matches) return
  for (const c of cards) {
    if (c.hidden) continue
    const a = before.get(c)
    const b = c.getBoundingClientRect()
    if (!a) { c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: EASE }); continue }
    const dx = a.left - b.left
    const dy = a.top - b.top
    if (Math.abs(dx) + Math.abs(dy) > 0.5) c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 220, easing: EASE })
  }
}
function setFace(face: ControllerId | null) { setFilters({ ...filters, face }) }
const clear = () => setFilters({ category: null, face: null, q: '' })
let searching = false
search.addEventListener('input', () => {
  setFilters({ ...filters, q: search.value.trim().slice(0, 160) }, false, searching ? 'replace' : 'push')
  searching = true
})
search.addEventListener('blur', () => { searching = false })
$('clear-filters').onclick = clear
$('sheet-clear').onclick = clear
addEventListener('popstate', () => { searching = false; setFilters(filtersFrom(location.search), false, 'none') })

// "/" goes to the search from anywhere but a field, opening the sidebar if it's folded.
addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || t.closest('input, textarea, select, [contenteditable], [role="combobox"]')) return
  e.preventDefault()
  if (side.mode === 'docked' && !side.expanded) side.expand()
  requestAnimationFrame(() => search.focus())
})

setFilters(filters, false, 'replace')
initTips()
fitControlInk()
// The kit's components sheet, for review: /sim/?kit=sheet.
if (new URLSearchParams(location.search).get('kit') === 'sheet') void import('../ui/kit/demo').then((m) => m.mountSheet())
Object.assign(window, {
  __sims: {
    cards: () => [...grid.children].filter((c) => !(c as HTMLElement).hidden).map((c) => (c as HTMLElement).dataset.id),
    setFace,
    previews: previews.stats,
    side: () => ({ mode: side.mode, expanded: side.expanded }),
  },
})
document.getElementById('seo-list')?.remove()
