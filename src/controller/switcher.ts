/**
 * Which controller the phone is: the controller bar and the controller catalogue (CATALOGUE §9.3).
 *
 * The bar holds one slot per face the screen takes (./ratings.ts), best first, each an icon; the one in use shows its
 * name too. Its last slot opens the catalogue: every controller as a card, its icon ringed by the glass kit's dot gauge
 * (../ui/kit/gauge.ts) lit a third, two thirds or all the way round by how well it fits this screen, the screen's best
 * marked with a spark, and the ones the screen doesn't take dimmed. A long press on a card says what it is for, or why
 * it's out. One tap on a card or a slot switches.
 */
import { CONTROLLERS, type ControllerId } from '@obpal/core'
import { html, setMarkup } from '../ui/markup'
import { ICONS } from '../ui/icons'
import { RingGauge } from '../ui/kit/gauge'
import { barSlots, CONTROLLER_ICON, FACE_OF, SHORT_NAME, type Face, type Rating } from './ratings'
import { sheetExits } from './sheet'
import { uiRect } from './uiframe'

/** Held this long (ms), a card or a slot says what it is instead of switching. */
const LONG_PRESS_MS = 420

export interface SwitcherDeps {
  /** Switch to a controller (the keyboard opens its dock). Called inside the tap, so the keyboard can take the focus. */
  pick: (id: ControllerId) => void
  /** A light tick, or a firmer one. */
  feel: (strong?: boolean) => void
  /** Something to say in a toast. */
  toast: (text: string) => void
  hand?: () => void
}

/**
 * A fit as the kit's dot gauge draws it: a ring of dots from twelve o'clock, a third lit for "works", two thirds for
 * "suits", all of it for the best. `size` is its diameter (px).
 */
function fitRing(fit: number, size: number, dots: number, thickness: number): HTMLElement {
  const ring = new RingGauge({ label: 'Fit', value: fit, min: 0, max: 3, kind: 'dots', dots, sweep: 360, start: 0, size, thickness, format: () => '' })
  ring.el.setAttribute('aria-hidden', 'true')
  ring.el.removeAttribute('role')
  return ring.el
}

/** How a rating reads out loud, and on the card's long press. */
export function fitWords(r: Rating, host: string): string {
  if (!r.fit) return r.why
  if (r.best) return `Best for ${host}`
  return r.fit === 2 ? `Suits ${host}` : `Works on ${host}`
}

/** A controller's fit gauge around its icon, with its marks: best, needs motion, not here. */
function gauge(r: Rating) {
  return html`<span class="ctl-gauge" aria-hidden="true">
    ${fitRing(r.fit, 76, 24, 5.4)}
    <span class="ctl-disc">${ICONS[CONTROLLER_ICON[r.id]]}</span>
    ${r.best ? html`<i class="ctl-mark ctl-best">${ICONS.best}</i>` : r.fit === 0 ? html`<i class="ctl-mark ctl-no">${ICONS.ban}</i>` : r.needsMotion ? html`<i class="ctl-mark ctl-need">${ICONS.gyro}</i>` : ''}
  </span>`
}

/**
 * Press handling shared by the bar and the cards: a tap runs `tap`; held for LONG_PRESS_MS it runs `hold` instead (and
 * the click that follows the lift is dropped).
 */
function pressable(el: HTMLElement, tap: () => void, hold: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let held = false
  el.addEventListener('pointerdown', () => {
    held = false
    clearTimeout(timer)
    timer = setTimeout(() => { held = true; hold() }, LONG_PRESS_MS)
  })
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) el.addEventListener(ev, () => clearTimeout(timer))
  el.addEventListener('contextmenu', (e) => e.preventDefault())
  el.addEventListener('click', (e) => {
    if (held) { held = false; e.preventDefault(); return }
    tap()
  })
}

export class Switcher {
  private bar: HTMLElement | null = null
  private tabs: HTMLElement | null = null
  private signature = ''
  private sorted: Rating[] = []
  private current: ControllerId = 'face.trackpad'
  private typing = false
  private host = 'This screen'
  private sheet: HTMLElement | null = null
  /** What the open catalogue's cards were drawn from: they're drawn again only when it changes, never under a finger. */
  private drawn = ''
  private exits = () => {}
  private tipTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: SwitcherDeps) {}

  /** The bar's markup, for the surface: its slots are filled by render(). */
  html() {
    return html`<nav class="ctl-bar modes glass" aria-label="Controller">
      <span class="ctl-tabs" role="tablist" aria-label="Controller"></span>
      <span class="ctl-sep" aria-hidden="true"></span>
      <button type="button" class="ctl-more" id="ctl-more" aria-haspopup="dialog" aria-label="All controllers">${ICONS.models}</button>
    </nav>`
  }

  mount(surface: HTMLElement) {
    this.bar = surface.querySelector<HTMLElement>('.ctl-bar')
    this.tabs = this.bar?.querySelector<HTMLElement>('.ctl-tabs') ?? null
    this.signature = ''
    const more = this.bar?.querySelector<HTMLButtonElement>('#ctl-more')
    if (more) more.onclick = () => { this.deps.feel(); this.open() }
  }

  /**
   * The screen's ratings (best first) and the controller in use changed, or might have: redraw the bar's slots when
   * they differ, mark the one in use, and refresh an open catalogue.
   */
  render(sorted: Rating[], current: ControllerId, host: string, typing: boolean, camera = false, handActive = false) {
    this.sorted = sorted
    this.current = current
    this.host = host
    this.typing = typing
    const slots = barSlots(sorted, current)
    const best = sorted.find((r) => r.best)?.id ?? ''
    const signature = `${slots.map((s) => `${s.face}:${s.id}`).join(',')}|${best}|${camera}`
    if (this.tabs && signature !== this.signature) {
      this.signature = signature
      this.bar!.dataset.slots = String(slots.length + Number(camera))
      setMarkup(this.tabs, slots.map((s) => html`<button type="button" role="tab" class="ctl-tab" data-tab="${s.face}" data-c="${s.id}" aria-selected="false" aria-label="${CONTROLLERS[s.id].name}">
        <span class="ctl-tab-ic">${ICONS[CONTROLLER_ICON[s.id]]}${s.id === best ? html`<i class="ctl-tab-best"></i>` : ''}</span><span class="ctl-tab-t">${SHORT_NAME[s.id]}</span></button>`))
      this.tabs.querySelectorAll<HTMLButtonElement>('.ctl-tab').forEach((b) => {
        const id = b.dataset.c as ControllerId
        pressable(b, () => { this.deps.feel(); this.deps.pick(id) }, () => { this.deps.feel(true); this.say(id) })
      })
      if (camera) {
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'ctl-tab'; button.dataset.tab = 'camera-hand'
        button.setAttribute('role', 'tab'); button.setAttribute('aria-label', 'Hand camera')
        setMarkup(button, html`<span class="ctl-tab-ic">${ICONS.hand}</span><span class="ctl-tab-t">Hand</span>`)
        button.onclick = () => { this.deps.feel(); this.deps.hand?.() }
        this.tabs.append(button)
      }
    }
    const face: Face | null = FACE_OF[current]
    this.tabs?.querySelectorAll<HTMLElement>('.ctl-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === (handActive ? 'camera-hand' : face))))
    if (this.sheet) this.paintCards()
  }

  /** The cards' inputs, as one string: the ratings, the one in use, the keyboard, the screen's name. */
  private get drawnFrom() {
    return `${this.sorted.map((r) => `${r.id}${r.fit}${r.best ? '*' : ''}${r.needsMotion ? 'm' : ''}`).join()}|${this.current}|${this.typing}|${this.host}`
  }

  /** Open the catalogue. */
  open() {
    if (this.sheet) return
    const wrap = document.createElement('div')
    wrap.className = 'sheet-wrap ctl-wrap'
    setMarkup(wrap, html`<div class="sheet ctl-sheet glass" role="dialog" aria-label="Controllers">
      <div class="sheet-head"><div class="grip" aria-hidden="true"></div><button type="button" class="icon-btn sheet-x" data-act="close" aria-label="Close">${ICONS.close}</button></div>
      <header class="ctl-head"><h2>Controllers</h2><p class="ctl-for"><i></i><span></span></p></header>
      <div class="ctl-list" role="radiogroup" aria-label="Controllers"></div>
      <footer class="ctl-legend" aria-hidden="true">
        <span><i class="ctl-mark ctl-best">${ICONS.best}</i>Best</span>
        <span>${fitRing(2, 24, 9, 4)}Fit</span>
        <span class="ctl-legend-need"><i class="ctl-mark ctl-need">${ICONS.gyro}</i>Motion</span>
        <span><i class="ctl-mark ctl-no">${ICONS.ban}</i>Not here</span>
      </footer>
      <p class="ctl-tip" role="status" aria-live="polite" hidden></p>
    </div>`)
    document.body.appendChild(wrap)
    this.sheet = wrap
    this.drawn = ''
    wrap.querySelector<HTMLButtonElement>('[data-act="close"]')!.onclick = () => this.close()
    this.exits = sheetExits(wrap, () => this.close())
    this.paintCards()
    // The one in use in view, and the focus on it for a keyboard or a screen reader.
    const mine = wrap.querySelector<HTMLElement>('.ctl-card[aria-checked="true"]')
    mine?.scrollIntoView({ block: 'nearest' })
    mine?.focus({ preventScroll: true })
  }

  close() {
    const s = this.sheet
    if (!s) return
    this.sheet = null
    clearTimeout(this.tipTimer)
    this.exits()
    this.exits = () => {}
    s.classList.add('out')
    setTimeout(() => s.remove(), 200)
  }

  /** The cards: the ones this screen takes, best first, then the ones it doesn't, dimmed. */
  private paintCards() {
    const wrap = this.sheet
    if (!wrap || this.drawn === this.drawnFrom) return
    this.drawn = this.drawnFrom
    const list = wrap.querySelector<HTMLElement>('.ctl-list')!
    wrap.querySelector('.ctl-for span')!.textContent = this.host
    const ready = this.sorted.filter((r) => r.fit > 0)
    const out = this.sorted.filter((r) => r.fit === 0)
    // The legend names the motion mark only where a card wears it (a phone without motion sensors).
    wrap.querySelector<HTMLElement>('.ctl-legend-need')!.hidden = !ready.some((r) => r.needsMotion)
    const card = (r: Rating) => html`<button type="button" class="ctl-card" role="radio" data-c="${r.id}" data-fit="${r.fit}" aria-checked="false" aria-disabled="${r.fit === 0}">${gauge(r)}<span class="ctl-name">${CONTROLLERS[r.id].name}</span></button>`
    setMarkup(list, [
      html`<p class="ctl-k"><b>01</b>Ready here</p>`,
      html`<div class="ctl-grid">${ready.map(card)}</div>`,
      out.length ? html`<p class="ctl-k"><b>02</b>Not on this screen</p>` : '',
      out.length ? html`<div class="ctl-grid">${out.map(card)}</div>` : '',
    ])
    list.querySelectorAll<HTMLButtonElement>('.ctl-card').forEach((b) => {
      const id = b.dataset.c as ControllerId
      const r = this.sorted.find((x) => x.id === id)!
      const inUse = id === this.current || (id === 'face.keyboard' && this.typing)
      b.setAttribute('aria-checked', String(inUse))
      b.setAttribute('aria-label', `${CONTROLLERS[id].name}. ${fitWords(r, this.host)}${r.needsMotion ? '. Needs motion' : ''}`)
      pressable(b, () => {
        if (!r.fit) { this.deps.feel(true); this.tip(b, r); b.classList.remove('nope'); void b.offsetWidth; b.classList.add('nope'); return }
        this.deps.feel()
        b.classList.add('chosen')
        this.deps.pick(id)
        setTimeout(() => this.close(), 140)
      }, () => { this.deps.feel(true); this.tip(b, r) })
    })
  }

  /** Say what a card is, or why it's out, in a bubble over it. */
  private tip(card: HTMLElement, r: Rating) {
    const wrap = this.sheet
    if (!wrap) return
    const sheet = wrap.querySelector<HTMLElement>('.ctl-sheet')!
    const tip = wrap.querySelector<HTMLElement>('.ctl-tip')!
    setMarkup(tip, html`<b></b><span></span>`)
    tip.querySelector('b')!.textContent = CONTROLLERS[r.id].name
    tip.querySelector('span')!.textContent = r.fit
      ? `${fitWords(r, this.host)}. ${CONTROLLERS[r.id].for}${r.needsMotion ? '. It needs the phone’s motion sensors.' : '.'}`
      : `${r.why}.`
    tip.hidden = false
    tip.classList.remove('in')
    // Over the card, inside the sheet (in the UI's own frame, so a turned phone places it right).
    const s = uiRect(sheet)
    const c = uiRect(card)
    const w = Math.min(280, s.width - 24)
    const left = Math.max(12, Math.min(s.width - w - 12, c.left - s.left + c.width / 2 - w / 2))
    tip.style.width = `${w}px`
    tip.style.left = `${left}px`
    const above = c.top - s.top + sheet.scrollTop - 8
    tip.style.top = `${Math.max(sheet.scrollTop + 8, above - tip.offsetHeight)}px`
    tip.style.setProperty('--arrow', `${c.left - s.left + c.width / 2 - left}px`)
    void tip.offsetWidth
    tip.classList.add('in')
    clearTimeout(this.tipTimer)
    this.tipTimer = setTimeout(() => { tip.classList.remove('in'); setTimeout(() => { if (!tip.classList.contains('in')) tip.hidden = true }, 200) }, 2600)
  }

  /** A long press on a bar slot: its name and fit, as a toast. */
  private say(id: ControllerId) {
    const r = this.sorted.find((x) => x.id === id)
    if (r) this.deps.toast(`${CONTROLLERS[id].name} · ${fitWords(r, this.host)}`)
  }
}
