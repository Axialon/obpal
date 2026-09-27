/**
 * The sim catalogue (/sim/): a card for each sim with a live preview, the controllers that suit it (the best one lit)
 * and Try it, which opens the sim with its pairing chip. The bar filters by controller; ?face=wii (or face.wii) opens
 * filtered, so the control catalogue can link a controller to the sims that take it.
 */
import '../landing/site'
import { CONTROLLERS, type ControllerId } from '@obpal/core'
import { ICONS } from '../ui/icons'
import { CATEGORIES, filterSims, filtersFrom, filtersUrl, PROPOSED, SIMS, type CollectionId, type SimCard, type SimFilters } from './catalogue'
import { FACES, faceGlyph, faceShort } from './faces'
import { mountPreviews, type PreviewSlot } from './previews'

const $ = (id: string) => document.getElementById(id)!
const motion = matchMedia('(prefers-reduced-motion: reduce)')
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** A controller badge: its glyph and short name, the whole line on hover. */
function badge(c: ControllerId, card: SimCard, first: boolean) {
  const li = document.createElement('li')
  li.dataset.face = c
  if (first) li.className = 'first'
  li.title = [CONTROLLERS[c].name, card.how?.[c]].filter(Boolean).join(' · ')
  li.innerHTML = faceGlyph(c)
  const s = document.createElement('span')
  s.textContent = faceShort(c)
  li.appendChild(s)
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
  stage.innerHTML = `<span class="dcard-ph">${faceGlyph(card.controllers[0])}</span><canvas></canvas><span class="dcard-kind"></span>`
  stage.querySelector('.dcard-kind')!.textContent = CATEGORIES.find(c => c.id === card.category)?.name ?? card.kind
  const body = document.createElement('div')
  body.className = 'dcard-body'
  body.innerHTML = '<h2></h2><p></p><ul class="dcard-faces"></ul><div class="dcard-foot"><a class="btn primary dcard-go"></a></div>'
  body.querySelector('h2')!.textContent = card.name
  body.querySelector('p')!.textContent = card.blurb
  const faces = body.querySelector('ul')!
  faces.setAttribute('aria-label', 'Controllers that suit it')
  card.controllers.forEach((c, i) => faces.appendChild(badge(c, card, i === 0)))
  const go = body.querySelector<HTMLAnchorElement>('.dcard-go')!
  go.href = card.href!
  go.textContent = 'Try it'
  go.setAttribute('aria-label', `Try the ${card.name.toLowerCase()}`)
  el.append(stage, body)
  if (!card.preview) return { el, slot: null }
  const slot: PreviewSlot = { canvas: stage.querySelector('canvas')!, load: card.preview }
  return { el, slot }
}

function soonOf(card: SimCard) {
  const el = document.createElement('article')
  el.className = 'dsoon'
  el.dataset.faces = card.controllers.join(' ')
  el.innerHTML = `<span class="dsoon-ic">${ICONS[card.glyph ?? 'phone'] ?? ''}</span><div><b></b><p></p><ul class="dcard-faces"></ul></div>`
  el.querySelector('b')!.textContent = card.name
  el.querySelector('p')!.textContent = card.blurb
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

// ---- the filter: by controller ----

let filters = filtersFrom(location.search)
const search = $('search') as HTMLInputElement

function chip(id: ControllerId | null) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'sims-chip'
  b.dataset.face = id ?? ''
  b.innerHTML = id ? faceGlyph(id) : ICONS.models
  const name = document.createElement('span')
  name.textContent = id ? faceShort(id) : 'All'
  const count = document.createElement('i')
  b.append(name, count)
  b.title = id ? CONTROLLERS[id].for : 'Every sim'
  b.onclick = () => setFace(id)
  return b
}
$('filter').replaceChildren(chip(null), ...FACES.map(chip))
const collections: { id: CollectionId | null; name: string }[] = [{ id: null, name: 'All' }, { id: 'featured', name: 'Featured' }, { id: 'new', name: 'New' }, ...CATEGORIES]
$('categories').replaceChildren(...collections.map(c => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'sims-category'
  b.textContent = c.name
  b.dataset.category = c.id ?? ''
  b.onclick = () => setFilters({ ...filters, category: c.id })
  return b
}))
// The bar joins the top bar's glass once it sticks under it.
const sentinel = document.createElement('div')
sentinel.className = 'sims-sentinel'
document.querySelector('.sims-bar')!.before(sentinel)
new IntersectionObserver(([e]) => document.querySelector('.sims-bar')!.classList.toggle('stuck', !e.isIntersecting), { rootMargin: '-65px 0px 0px 0px' }).observe(sentinel)

/** Show the sims `next` suits, moving the cards that stay to their new places rather than jumping (FLIP). */
function setFilters(next: SimFilters, animate = true, navigation: 'push' | 'replace' | 'none' = 'push') {
  filters = next
  const { face } = filters
  const url = filtersUrl(new URL(location.href), filters)
  if (navigation !== 'none' && url.href !== location.href) history[navigation === 'push' ? 'pushState' : 'replaceState'](null, '', url)
  if (search.value.trim() !== filters.q) search.value = filters.q
  document.querySelectorAll<HTMLElement>('.sims-category').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.category || null) === filters.category)))
  document.querySelectorAll<HTMLButtonElement>('.sims-chip').forEach(b => {
    const id = b.dataset.face as ControllerId || null
    const n = filterSims(SIMS, { ...filters, face: id }).length
    b.setAttribute('aria-pressed', String(id === face))
    b.querySelector('i')!.textContent = String(n)
    b.disabled = n === 0 && id !== face && id !== null
  })
  const cards = [...grid.children] as HTMLElement[]
  const before = new Map(cards.map((c) => [c, c.hidden ? null : c.getBoundingClientRect()]))
  const matches = new Set(filterSims(SIMS, filters).map(c => c.id))
  const fits = (el: HTMLElement) => matches.has(el.dataset.id!)
  for (const c of cards) {
    c.hidden = !fits(c)
    c.querySelectorAll<HTMLElement>('.dcard-faces li').forEach((li) => li.classList.toggle('match', li.dataset.face === face))
  }
  document.querySelectorAll<HTMLElement>('.dsoon').forEach((c) => {
    c.classList.toggle('dim', !!face && !c.dataset.faces!.split(' ').includes(face))
    c.querySelectorAll<HTMLElement>('.dcard-faces li').forEach((li) => li.classList.toggle('match', li.dataset.face === face))
  })
  $('none').hidden = cards.some((c) => !c.hidden)
  $('result-count').textContent = `${matches.size} ${matches.size === 1 ? 'sim' : 'sims'}`
  $('clear-filters').hidden = !filters.category && !face && !filters.q
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
let searching = false
search.addEventListener('input', () => {
  setFilters({ ...filters, q: search.value.trim().slice(0, 160) }, false, searching ? 'replace' : 'push')
  searching = true
})
search.addEventListener('blur', () => { searching = false })
$('clear-filters').onclick = () => setFilters({ category: null, face: null, q: '' })
addEventListener('popstate', () => { searching = false; setFilters(filtersFrom(location.search), false, 'none') })
setFilters(filters, false, 'replace')
Object.assign(window, { __sims: { cards: () => [...grid.children].filter((c) => !(c as HTMLElement).hidden).map((c) => (c as HTMLElement).dataset.id), setFace, previews: previews.stats } })
