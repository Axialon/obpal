/**
 * Quick actions: a slim glass tab on the right edge of every ob.Pal page (not the phone controller, which has its own
 * UI, nor the embed, which lives in other sites) that slides out a column of round icon actions, each with a glass
 * tooltip: the primary action, page shortcuts, then fullscreen, sound and theme where they apply.
 *
 * One registry (./quick-actions.ts): a page offers what it has with quickAction() (quickViews() for a camera that
 * steps through views), and mountQuick() adds what the tray can do itself: fullscreen; pairing, through the page's own
 * people chip where there is one, else by opening the viewer; and the visitor's surface picker. The tab keeps clear
 * of the page's bar, the pairing chip and
 * its card, and anything else fixed on that edge; sim windows keep clear of it (styles/panels.css), as does the chip
 * on a phone on its side (styles/quick.css), whose card folds while the open column is over it. Esc, a click outside
 * or a swipe back to the edge closes it; it's a toolbar for the keyboard; reduced motion shows it without the slide.
 */
import '../styles/kit.css'
import '../styles/quick.css'
import { family } from '../family'
import { ICONS } from './icons'
import { html, setMarkup } from './markup'
import { edgeSpot, freeSpans, placeTrayCard, type Box } from './kit/place'
import { mountPairCameraActions, openPairCamera, phoneCamera } from './camera'
import { onQuickChange, orderedQuickActions, quickKey, quickActions, quickDefault, type QuickId } from './quick-actions'
import { hint, dismissHint } from './hints'

export { dropQuickAction, quickAction, quickChanged, quickViews, type QuickAction, type QuickId, type QuickView } from './quick-actions'

const actions = quickActions()
let tray: QuickTray | null = null
onQuickChange((what) => { if (what === 'actions') tray?.render(); else tray?.sync() })

/** The tray on this page, once, with what the tray does itself. */
export function mountQuick() {
  if (tray) return tray
  mountPairCameraActions()
  if (document.fullscreenEnabled) quickDefault({
    id: 'fullscreen', group: 'system', label: 'Full screen', hint: 'Fill the screen; Esc comes back', stay: true,
    icon: () => (document.fullscreenElement ? 'fullscreen-exit' : 'fullscreen'),
    pressed: () => !!document.fullscreenElement,
    run: () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); else void document.documentElement.requestFullscreen?.().catch(() => {}) },
  })
  const invite = document.getElementById('chip-invite')
  quickDefault(phoneCamera() ? {
    id: 'scan', group: 'primary', label: 'Scan a code', hint: 'Connect to the screen in front of you', icon: 'frame',
    run: openPairCamera,
  } : invite ? {
    // The page's people chip opens its pairing card (@obpal/host's PairingChip).
    id: 'pair', group: 'primary', label: 'Pair a phone', hint: 'Show the code to scan', icon: 'phone',
    expanded: () => invite.getAttribute('aria-pressed') === 'true',
    run: () => invite.click(),
  } : {
    id: 'pair', group: 'primary', label: 'Pair a phone', hint: 'Open the viewer and scan its code', icon: 'phone',
    run: () => { location.href = '/view/' },
  })
  quickDefault({
    id: 'theme', group: 'system', label: 'Theme', hint: 'Surface and accent', icon: 'palette', stay: true,
    run: () => {}, // The family picker owns its button's click and keyboard handling.
  })
  if (!location.pathname.startsWith('/view') && (!location.pathname.startsWith('/sim/') || location.pathname === '/sim/')) {
    const next = [['Viewer', '/view/', 'cube'], ['Sims', '/sim/', 'gamepad'], ['Link', '/link/', 'link']]
    next.forEach(([label, href, icon], i) => quickDefault({ id: `next${i + 1}` as QuickId, group: 'page', label, icon, hint: `Open ${label}`, run: () => { location.href = href } }))
  }
  tray = new QuickTray()
  return tray
}

/** The tab, the column it slides out, the tooltip, and the surface picker the column can open. */
class QuickTray {
  readonly el = document.createElement('nav')
  private readonly tab = document.createElement('button')
  private readonly panel = document.createElement('div')
  private readonly tip = document.createElement('div')
  private readonly buttons = new Map<QuickId, HTMLButtonElement>()
  private picker: { menu: HTMLElement; api: { open(): void; close(): void; place(): void } } | null = null
  private frame = 0
  private sliding = 0
  private swipe: { id: number; x: number; y: number; done: boolean } | null = null

  constructor() {
    document.documentElement.classList.add('quick-on')
    this.el.className = 'quick-tray'
    this.el.setAttribute('aria-label', 'Quick actions')
    this.el.dataset.open = 'false'
    this.tab.type = 'button'
    this.tab.className = 'quick-tab'
    this.tab.setAttribute('aria-label', 'Shortcuts')
    this.tab.setAttribute('aria-expanded', 'false')
    this.tab.setAttribute('aria-controls', 'quick-actions')
    this.panel.className = 'quick-panel'
    this.panel.id = 'quick-actions'
    this.panel.setAttribute('role', 'toolbar')
    this.panel.setAttribute('aria-label', 'Quick actions')
    this.panel.setAttribute('aria-orientation', 'vertical')
    this.panel.dataset.shown = 'hidden'
    this.panel.addEventListener('transitionend', (e) => { if (e.target === this.panel) this.settle() })
    this.tip.className = 'quick-tip'
    this.tip.setAttribute('role', 'tooltip')
    this.tip.id = 'quick-tip'
    this.tip.hidden = true
    this.el.append(this.tab, this.panel)
    document.body.append(this.el, this.tip)

    // Keyboard: a press on the tab from the keyboard lands on the first action.
    this.tab.addEventListener('click', (e) => this.toggle(e.detail === 0))
    this.panel.addEventListener('keydown', (e) => this.key(e))
    document.addEventListener('keydown', e => {
      if (document.querySelector('dialog[open], .sheet-wrap')) return
      const id = quickKey(e)
      if (!id) return
      e.preventDefault()
      e.stopPropagation()
      if (id === 'shortcuts') {
        if (!this.open) this.toggle(false)
        const first = orderedQuickActions()[0]?.id
        if (first) { this.roving(first); this.buttons.get(first)?.focus() }
      } else this.buttons.get(id)?.click()
    })
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.open) { e.stopPropagation(); this.close(true) } })
    // Leaving it (a click elsewhere, or focus moving on) closes it; its own surface picker is part of it.
    document.addEventListener('pointerdown', (e) => { if (this.open && !this.owns(e.target as Node)) this.close(false) }, true)
    this.el.addEventListener('focusout', (e) => { if (this.open && e.relatedTarget && !this.owns(e.relatedTarget as Node)) this.close(false) })
    // A swipe back toward the edge closes it; on the tab, a swipe away from the edge opens it. Once a press moves
    // sideways it's a swipe: the tray keeps the pointer (so the edge doesn't cut it short) and it presses nothing.
    this.el.addEventListener('pointerdown', (e) => { this.swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, done: false } })
    this.el.addEventListener('pointermove', (e) => {
      const s = this.swipe
      if (!s || s.id !== e.pointerId || s.done) return
      const dx = e.clientX - s.x, dy = e.clientY - s.y
      if (Math.abs(dy) > Math.abs(dx)) return
      if (Math.abs(dx) > 6 && !this.el.hasPointerCapture(e.pointerId)) this.el.setPointerCapture(e.pointerId)
      if (Math.abs(dx) < 24) return
      if (dx > 0 && this.open) { s.done = true; this.close(false) }
      else if (dx < 0 && !this.open) { s.done = true; this.toggle(false) }
    })
    const end = (e: PointerEvent) => { if (this.swipe?.id === e.pointerId) setTimeout(() => { this.swipe = null }) }
    this.el.addEventListener('pointerup', end)
    this.el.addEventListener('pointercancel', end)
    // A swipe that ended over a button isn't also a press on it.
    this.el.addEventListener('click', (e) => { if (this.swipe?.done) { e.stopPropagation(); e.preventDefault() } }, true)

    const place = () => { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.place() }) }
    for (const type of ['resize', 'scroll', 'obpal:panels']) addEventListener(type, place, { passive: true })
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    new ResizeObserver(place).observe(this.panel)
    document.addEventListener('fullscreenchange', () => this.sync())
    // The pairing chip opens and folds its card on that edge: the tray moves to stay clear.
    const watch = () => {
      const wrap = document.querySelector('.obpal-chip')?.shadowRoot?.querySelector('.wrap')
      if (!wrap) return false
      new ResizeObserver(place).observe(wrap)
      // The card opens with a short animation: placed again once it has settled. Pairing's switch shows it open or not.
      new MutationObserver(() => { place(); this.sync(); setTimeout(place, 400) }).observe(wrap, { attributes: true, attributeFilter: ['data-open'] })
      return true
    }
    if (!watch()) {
      const mo = new MutationObserver(() => { if (watch()) { mo.disconnect(); place() } })
      mo.observe(document.body, { childList: true })
    }
    this.render()
    place()
    hint('quick.shortcuts', () => this.open ? null : this.tab, 'Shortcuts', { place: 'left', delay: 1200 })
  }

  get open() { return this.el.dataset.open === 'true' }
  private owns(node: Node | null) { return !!node && (this.el.contains(node) || this.tip.contains(node) || !!this.picker?.menu.contains(node)) }

  /** The page's actions, in the tray's order; a button each, kept between renders so focus stays. */
  render() {
    const focused = this.focused()
    const ordered = orderedQuickActions()
    const shown = ordered.map(a => a.id)
    const primary = ordered.find(a => a.group === 'primary')
    const glyph = primary && (typeof primary.icon === 'function' ? primary.icon() : primary.icon)
    if (glyph && this.tab.dataset.glyph !== glyph) {
      this.tab.dataset.glyph = glyph
      setMarkup(this.tab, ICONS[glyph] ?? ICONS.phone)
    }
    for (const [id, b] of this.buttons) if (!shown.includes(id)) { b.remove(); this.buttons.delete(id) }
    let previous = ''
    for (const id of shown) {
      let b = this.buttons.get(id)
      if (!b) {
        b = document.createElement('button')
        b.type = 'button'
        b.className = 'quick-btn'
        b.dataset.quick = id
        b.tabIndex = -1
        b.addEventListener('click', () => this.run(id))
        const show = () => this.showTip(id)
        b.addEventListener('pointerenter', show)
        b.addEventListener('focus', show)
        b.addEventListener('pointerleave', () => this.hideTip())
        b.addEventListener('blur', () => this.hideTip())
        this.buttons.set(id, b)
        // The surface picker is the family's popover on this button: it opens and closes with the button's clicks.
        if (id === 'theme') this.mountPicker(b)
      }
      const group = actions.get(id)!.group
      b.dataset.group = group
      b.classList.toggle('quick-divider', !!previous && previous !== group)
      previous = group
      this.panel.append(b)
    }
    this.tab.hidden = !shown.length
    this.sync()
    this.roving(focused ?? shown[0])
    this.place()
    if (this.open && focused) this.buttons.get(focused)?.focus({ preventScroll: true })
  }

  /** Names, icons and switches' states, as they are now. */
  sync() {
    for (const [id, b] of this.buttons) {
      const a = actions.get(id)
      if (!a) continue
      const icon = typeof a.icon === 'function' ? a.icon() : a.icon
      // (data-glyph, not data-icon: pages fill every [data-icon] with its icon when they start.)
      if (b.dataset.glyph !== icon) { setMarkup(b, html`${ICONS[icon] ?? ''}`); b.dataset.glyph = icon }
      b.setAttribute('aria-label', a.label)
      if (a.pressed) b.setAttribute('aria-pressed', String(a.pressed()))
      else b.removeAttribute('aria-pressed')
      if (a.expanded) b.setAttribute('aria-expanded', String(a.expanded()))
      else if (id !== 'theme') b.removeAttribute('aria-expanded')
    }
    if (!this.tip.hidden && this.tip.dataset.for) this.showTip(this.tip.dataset.for as QuickId)
  }

  private run(id: QuickId) {
    const a = actions.get(id)
    if (!a) return
    // What it opens (the picker, the pairing card) comes up without the tooltip over it.
    const reading = this.tip.dataset.for === id
    this.hideTip()
    a.run()
    if (!a.stay) this.close(false)
    // Switches' states once the action's own handlers have had their turn (a menu it opens, a card it unfolds); a
    // tooltip being read on one that stays (a switch, the camera's next view) comes back with what it says now, unless
    // the surface picker is open beside it.
    requestAnimationFrame(() => {
      this.sync()
      if (reading && a.stay && this.open && (!this.picker || this.picker.menu.hidden)) this.showTip(id)
    })
  }

  toggle(fromKeyboard: boolean) {
    dismissHint('quick.shortcuts')
    if (this.open) { this.close(true); return }
    this.el.dataset.open = 'true'
    this.tab.setAttribute('aria-expanded', 'true')
    this.slide('opening')
    this.place()
    if (fromKeyboard) this.buttons.get(this.focusable())?.focus()
  }

  close(refocus: boolean) {
    if (!this.open) return
    const inside = this.el.contains(document.activeElement)
    this.el.dataset.open = 'false'
    this.tab.setAttribute('aria-expanded', 'false')
    this.slide('closing')
    this.hideTip()
    this.picker?.api.close()
    this.place()
    if (refocus || inside) this.tab.focus({ preventScroll: true })
  }

  /**
   * The column says on itself where its slide is (data-shown: opening, shown, closing, hidden), as it starts and once
   * it has finished, since a pairing chip keeps its card from under the page's panels (its `avoid`, which lists the
   * column): the card folds while the open column is over it and comes back once the column has gone.
   */
  private slide(state: 'opening' | 'closing') {
    this.panel.dataset.shown = state
    clearTimeout(this.sliding)
    // (The end of the slide, or at once without motion; the timer in case no transition ends.)
    this.sliding = setTimeout(() => this.settle(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450)
  }
  private settle() {
    const state = this.open ? 'shown' : 'hidden'
    if (this.panel.dataset.shown !== state) this.panel.dataset.shown = state
  }

  /** The column is one tab stop: the arrow keys move through it, Home and End jump. */
  private key(e: KeyboardEvent) {
    const ids = orderedQuickActions().map(a => a.id)
    const at = ids.indexOf(this.focused() ?? ids[0])
    const to = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? at - 1
      : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : null
    if (to === null || !ids.length) return
    e.preventDefault()
    const id = ids[(to + ids.length) % ids.length]
    this.roving(id)
    this.buttons.get(id)!.focus()
  }
  private focused() {
    for (const [id, b] of this.buttons) if (b === document.activeElement) return id
    return null
  }
  private focusable() {
    for (const [id, b] of this.buttons) if (b.tabIndex === 0) return id
    return orderedQuickActions()[0]?.id
  }
  private roving(id: QuickId | undefined) { for (const [k, b] of this.buttons) b.tabIndex = k === id ? 0 : -1 }

  /** A glass tooltip beside the column: the action's name and what it does. */
  private showTip(id: QuickId) {
    const a = actions.get(id), b = this.buttons.get(id)
    if (!a || !b || !this.open || (this.picker && !this.picker.menu.hidden)) return
    const name = document.createElement('b'), what = document.createElement('span')
    name.textContent = a.label
    what.textContent = a.hint ?? ''
    this.tip.replaceChildren(name, ...(a.hint ? [what] : []))
    if (a.key && matchMedia('(hover: hover)').matches) {
      const key = document.createElement('kbd'); key.textContent = a.key; name.append(key)
    }
    this.tip.dataset.for = id
    this.tip.hidden = false
    this.placeCard(this.tip, b)
    b.setAttribute('aria-describedby', this.tip.id)
  }
  private hideTip() {
    this.tip.hidden = true
    delete this.tip.dataset.for
    for (const b of this.buttons.values()) b.removeAttribute('aria-describedby')
  }

  /** The family's surface picker as the theme button's popover (the family opens and closes it with the button). */
  private mountPicker(button: HTMLButtonElement) {
    const menu = document.createElement('div')
    menu.className = 'bb-menu bb-glass themes-menu quick-themes'
    menu.setAttribute('aria-label', 'Surface and accent')
    document.body.append(menu)
    this.picker = { menu, api: family.mountThemes(button, menu, () => {
      this.hideTip()
      // A non-modal sheet on a narrow phone: the same choices and keyboard behaviour, with an explicit close target.
      if (!menu.querySelector('.quick-theme-close')) {
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'quick-theme-close'
        close.setAttribute('aria-label', 'Close theme')
        setMarkup(close, ICONS.close)
        close.addEventListener('click', () => { this.picker?.api.close(); button.focus({ preventScroll: true }) })
        menu.prepend(close)
      }
      this.placeCard(menu, button, true)
    }) }
  }

  /** Safe-area insets and the page's full-width bars bound the usable visual viewport, including zoom and keyboards. */
  private bounds(): Box {
    const view = window.visualViewport, style = getComputedStyle(this.el)
    const inset = (side: string) => parseFloat(style.getPropertyValue(`--quick-safe-${side}`)) || 0
    const x = view?.offsetLeft ?? 0, y = view?.offsetTop ?? 0
    const width = view?.width ?? innerWidth, height = view?.height ?? innerHeight
    let top = y + inset('top'), bottom = y + height - inset('bottom')
    for (const el of document.querySelectorAll('.sim-top, .topbar, header.top, .top, .panel-dock, .dock')) {
      const r = el.getBoundingClientRect(), css = getComputedStyle(el)
      if (r.width < width / 2 || !r.height || css.visibility === 'hidden' || !['fixed', 'sticky'].includes(css.position)) continue
      if (r.top <= top + 12 && r.bottom > top) top = r.bottom
      else if (r.bottom >= bottom - 12 && r.top < bottom) bottom = r.top
    }
    const left = x + inset('left')
    return { left, top, width: Math.max(0, width - inset('left') - inset('right')), height: Math.max(0, bottom - top) }
  }

  private placeCard(card: HTMLElement, button: HTMLElement, picker = false) {
    const bounds = this.bounds(), sheet = picker && bounds.width < 480
    card.classList.toggle('quick-sheet', sheet)
    card.style.position = 'fixed'
    card.style.maxWidth = `${Math.max(0, bounds.width - 24)}px`
    card.style.maxHeight = 'none'
    const pill = document.querySelector('.obpal-chip')?.shadowRoot?.querySelector('.pill')?.getBoundingClientRect()
    const at = placeTrayCard(button.getBoundingClientRect(), card.getBoundingClientRect(), bounds, { sheet, column: this.panel.getBoundingClientRect(), avoid: pill?.width ? [pill] : [] })
    card.style.left = `${at.left}px`
    card.style.top = `${at.top}px`
    card.style.maxHeight = `${at.maxHeight}px`
  }

  /**
   * Its place on the edge: the column's middle (or the tab's, closed) as near its natural height as it can be, clear of
   * the page's bar at the top, the pairing chip and its card, and anything else fixed on that edge. Where the clear
   * stretch is shorter than the column (a phone on its side), the actions wrap into a second column.
   */
  place() {
    const h = window.visualViewport?.height ?? innerHeight, w = window.visualViewport?.width ?? innerWidth
    const coarse = matchMedia('(pointer: coarse)').matches
    const bounds = this.bounds()
    const top = bounds.top + 12, bottom = bounds.top + bounds.height - 12
    // What's fixed on that edge: the pairing chip's pill, and its card while it's open (folded, the card keeps its box
    // but isn't there); the viewer's viewpoint row; a sim's badge and windows; the home page's sound button.
    const chip = document.querySelector('.obpal-chip')?.shadowRoot
    const things = [chip?.querySelector('.pill'), chip?.querySelector('.wrap')?.hasAttribute('data-open') ? chip.querySelector('.card') : null,
      ...document.querySelectorAll('.presence-floating, .sim-badge, [data-sound], .sim-window:not([hidden])')]
      .filter((el): el is Element => !!el && !(el as HTMLElement).hidden).map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height)
    // Those within `reach` of the edge are in the way.
    const right = bounds.left + bounds.width
    const blockedBy = (reach: number) => things.filter((r) => r.right > right - reach && r.left < right).map((r): [number, number] => [r.top - 8, r.bottom + 8])
    const count = Math.max(1, this.buttons.size)
    const button = parseFloat(getComputedStyle(this.panel).getPropertyValue('--quick-btn')) || 40, gap = 8, pad = 16
    let rows = count, blocked = blockedBy((this.tab.offsetWidth || 24) + 4), need = this.tab.offsetHeight || 56
    if (this.open) {
      // Its width with `cols` columns, and its 8px from the edge; how many rows a stretch of the edge holds.
      const reach = (cols: number) => cols * button + (cols - 1) * gap + pad + 8
      const fit = (room: number) => Math.max(1, Math.min(count, Math.floor((room - pad + gap) / (button + gap))))
      for (let cols = 1; cols <= count; cols++) {
        blocked = blockedBy(reach(cols))
        const room = Math.max(0, ...freeSpans(top, bottom, blocked).map(([a, b]) => b - a))
        // Nowhere clear at all: over whatever is there for the moment it's open (the pairing card folds for it), in
        // as many rows as the edge holds.
        if (room < button + pad) { rows = fit(bottom - top); blocked = []; break }
        rows = fit(room)
        if (Math.ceil(count / rows) <= cols) break
      }
      need = rows * button + (rows - 1) * gap + pad
    }
    this.panel.style.setProperty('--quick-rows', String(rows))
    for (const [i, b] of [...this.buttons.values()].entries()) b.classList.toggle('quick-column-start', i % rows === 0)
    // A phone held upright: the lower middle, under the thumb; elsewhere, the middle.
    const want = (window.visualViewport?.offsetTop ?? 0) + h * (coarse && h > w ? 0.6 : 0.5)
    this.el.style.setProperty('--quick-y', `${Math.round(edgeSpot(want, need, top, bottom, blocked))}px`)
    this.picker?.api.place()
    if (!this.tip.hidden && this.tip.dataset.for) this.showTip(this.tip.dataset.for as QuickId)
  }
}
