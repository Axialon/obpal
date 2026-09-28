/**
 * The sims' windows: frosted widget cards over the stage that move, resize, minimise, close and come back from a slim
 * icon rail on the left, the dock. Each window's header is its handle: an icon badge and its name in small caps, with
 * round buttons to enlarge (cameras), minimise and close. A window keeps the height its content needs until a person
 * sizes it; moving it doesn't change that. Layouts are remembered per sim and screen class (./layout.ts). Moving a
 * window never replaces its controls or their listeners.
 */
import '../../styles/kit.css'
import '../../styles/panels.css'
import { clampRect, clearLayout, defaultPlacement, fitHeight, layoutKey, LIMITS, readLayout, resizeRect, screenClass, snapMove, writeLayout, type Anchor, type Edge, type Layout, type LayoutStorage, type Limits, type PanelState, type Placement, type Rect } from './layout'

export type PanelIcon = 'controls' | 'camera' | 'scores' | 'arm' | 'station' | 'record' | 'view' | 'sound'
export interface PanelOptions {
  id: string
  title: string
  purpose: string
  icon: PanelIcon
  anchor: Anchor
  index?: number
  limits?: Limits
  state?: PanelState
  camera?: boolean
}
const paths: Record<PanelIcon | 'close' | 'minimise' | 'expand' | 'restore' | 'reset' | 'dock', string> = {
  controls: 'M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9M15 5.3v4.4M9 14.3v4.4',
  camera: 'M4.8 8.2h2.7l1.5-2h6l1.5 2h2.7a1.6 1.6 0 0 1 1.6 1.6v7.6a1.6 1.6 0 0 1-1.6 1.6H4.8a1.6 1.6 0 0 1-1.6-1.6V9.8a1.6 1.6 0 0 1 1.6-1.6ZM12 16.5a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6Z',
  scores: 'M8 3.5h8v6.5a4 4 0 0 1-8 0zM8 5.5H4.5v2.2a3.3 3.3 0 0 0 3.5 3.3M16 5.5h3.5v2.2A3.3 3.3 0 0 1 16 11M12 14v5M8.5 20.5h7',
  arm: 'M4.5 20.5h10M6.8 20.5v-2.1a1.4 1.4 0 0 1 1.4-1.4h2.6a1.4 1.4 0 0 1 1.4 1.4v2.1M9.6 17l3.5-8.1M14 9a2.1 2.1 0 1 0 0-4.2A2.1 2.1 0 0 0 14 9ZM16 7.8l3.4 3.3M17.4 14.2l1.9-2.9 2.2 1.6',
  station: 'M9 17.4V6l10-2.2v11.6M9 9.3l10-2.2M6.8 19.7a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6ZM16.8 17.7a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Z',
  record: 'M6.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5ZM8.5 8h7M8.5 12h7M8.5 16h4',
  view: 'M2.5 12s3.6-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.6 6.5-9.5 6.5S2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  sound: 'M4.5 9.6h3.1L12 6v12l-4.4-3.6H4.5ZM15.2 9.3a3.8 3.8 0 0 1 0 5.4M17.8 6.8a7.4 7.4 0 0 1 0 10.4',
  close: 'M7 7l10 10M17 7 7 17', minimise: 'M6.5 12h11', expand: 'M9 4.5H4.5V9M15 4.5h4.5V9M4.5 15v4.5H9M19.5 15v4.5H15',
  restore: 'M4.5 9H9V4.5M19.5 9H15V4.5M9 19.5V15H4.5M15 19.5V15h4.5',
  reset: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4', dock: 'M9.5 6.5 15 12l-5.5 5.5',
}
/** Each studio station's own instrument. */
const stations = [
  'M4 8c0-5 16-5 16 0s-16 5-16 0v9c0 5 16 5 16 0V8M8 11v8M16 11v8',
  'M3 9h8v11H3zM14 5h7v12h-7zM3 9c0-4 8-4 8 0M14 5c0-4 7-4 7 0',
  'M3 7h4v14H3zM9 5h4v14H9zM15 3h4v14h-4zM3 3l18 18',
  'M3 5h18v14H3zM7 5v14M11 5v14M15 5v14M18 5v14M5 5v7M9 5v7M13 5v7',
  'M3 5h18v14H3zM8 9h2M14 9h2M7 15h10M6 3v2M18 3v2',
  'M3 16h18v5H3zM6 16V7M12 16V4M18 16V9M4 7h4M10 4h4M16 9h4',
  'M4 20V4M4 4l14 4M4 20l14-4M8 6v12M12 7v10M16 8v8M18 8v8',
  'M3 6h18v14H3zM7 10h2v2H7zM15 10h2v2h-2zM7 16h2M15 16h2',
]
function icon(name: keyof typeof paths, index?: number) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', name === 'station' ? stations[(index ?? 0) % stations.length] : paths[name]); svg.append(path)
  const span = document.createElement('span'); span.className = 'panel-icon'; span.append(svg)
  if (index !== undefined) { const number = document.createElement('sup'); number.textContent = String(index + 1); span.append(number) }
  return span
}
function button(label: string, glyph: keyof typeof paths) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'panel-btn'; b.setAttribute('aria-label', label); b.title = label; b.append(icon(glyph)); return b
}
/** Portrait phones keep the stage in view: a window there stands on the bottom edge, no taller than this share. */
const PORTRAIT_SHARE = 0.58

export class SimPanel {
  readonly element = document.createElement('section')
  readonly body = document.createElement('div')
  readonly handle = document.createElement('button')
  readonly toggle: HTMLButtonElement
  placement: Placement
  private restore: Rect | null = null
  private expand: HTMLButtonElement | null = null
  private readonly header = document.createElement('header')
  /** Watches the content's height, for a window that follows it. */
  private readonly observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.fit()) : null
  constructor(readonly owner: Panels, public content: HTMLElement, readonly options: PanelOptions) {
    const { id, title, purpose } = options
    this.placement = owner.placement(options)
    this.element.className = 'sim-window'; this.element.dataset.panel = id; this.element.id = `sim-window-${id}`
    this.element.setAttribute('aria-label', title); this.element.setAttribute('role', 'region')
    const header = this.header; header.className = 'panel-header'
    // The handle is the header's name: drag it, or use its keys, to move the window.
    this.handle.type = 'button'; this.handle.className = 'panel-handle'
    const badge = icon(options.icon, options.index); badge.classList.add('panel-badge')
    const name = document.createElement('span'); name.className = 'panel-title'; name.textContent = title
    this.handle.append(badge, name)
    this.handle.setAttribute('aria-label', `${title}: move or resize`); this.handle.setAttribute('aria-describedby', 'panel-help')
    this.handle.title = 'Drag to move. Arrow keys move; Shift + arrows resize.'
    header.append(this.handle)
    if (options.camera) {
      this.element.classList.add('panel-camera')
      const expand = button(`Enlarge ${title}`, 'expand')
      this.expand = expand
      expand.onclick = () => {
        if (this.restore || this.enlarged()) { this.placement.rect = clampRect(this.restore ?? owner.default(options).rect, owner.area(), options.limits); this.restore = null }
        else { this.restore = { ...this.placement.rect }; this.placement.rect = clampRect(owner.area(), owner.area(), options.limits) }
        this.draw(); owner.save()
      }
      header.append(expand)
    }
    const minimise = button(`Minimise ${title}`, 'minimise'), close = button(`Close ${title}`, 'close')
    minimise.onclick = () => this.setState('minimised'); close.onclick = () => this.setState('closed'); header.append(minimise, close)
    this.body.className = 'panel-body'; this.body.append(content); this.element.append(header, this.body)
    this.toggle = document.createElement('button'); this.toggle.type = 'button'; this.toggle.className = 'panel-toggle'
    this.toggle.append(icon(options.icon, options.index)); this.toggle.dataset.panelToggle = id
    this.toggle.setAttribute('aria-label', title); this.toggle.setAttribute('aria-controls', this.element.id); this.toggle.setAttribute('aria-description', purpose)
    this.toggle.onclick = () => { this.setState(this.placement.state === 'open' ? 'minimised' : 'open'); if (this.placement.state === 'open') { this.handle.focus({ preventScroll: true }); owner.collapseDock() } }
    owner.tip(this.toggle, title, purpose)
    this.bindDrag(this.handle)
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Edge[]) {
      const grip = document.createElement('div'); grip.className = `panel-resize panel-resize-${edge}`; grip.dataset.edge = edge; grip.setAttribute('aria-hidden', 'true')
      this.element.append(grip); this.bindDrag(grip, edge)
    }
    this.element.addEventListener('pointerdown', () => owner.focus(this))
    this.element.addEventListener('focusin', () => owner.focus(this))
    this.element.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); this.setState('closed'); return }
      if (e.target !== this.handle || !e.key.startsWith('Arrow')) return
      e.preventDefault(); e.stopPropagation()
      const dx = e.key === 'ArrowRight' ? 10 : e.key === 'ArrowLeft' ? -10 : 0, dy = e.key === 'ArrowDown' ? 10 : e.key === 'ArrowUp' ? -10 : 0
      const rect = this.placement.rect
      if (e.shiftKey) { this.placement.rect = resizeRect(rect, 'se', dx, dy, owner.area(), options.limits, [], 0); this.placement.fit = false }
      else this.placement.rect = clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, owner.area(), options.limits)
      this.restore = null; this.draw(); owner.save()
    })
    this.observer?.observe(content)
    this.draw()
  }
  get visible() { return this.placement.state === 'open' && !this.owner.root.hidden }
  private enlarged() { const area = this.owner.area(), r = this.placement.rect; return Math.abs(r.w - area.w) < 1 && Math.abs(r.h - area.h) < 1 }
  replace(content: HTMLElement) {
    if (content !== this.content) { this.observer?.unobserve(this.content); this.observer?.observe(content) }
    this.content = content; this.body.replaceChildren(content); this.fit()
  }
  reset() { this.restore = null; this.placement = this.owner.placement(this.options); delete this.toggle.dataset.activity; this.toggle.setAttribute('aria-description', this.options.purpose); this.draw(); this.fit() }
  notify() { if (!this.visible) { this.toggle.dataset.activity = 'true'; this.toggle.setAttribute('aria-description', `${this.options.purpose}. New activity`) } }
  setState(state: PanelState) {
    const hadFocus = this.element.contains(document.activeElement)
    this.placement.state = state
    if (state === 'open') { delete this.toggle.dataset.activity; this.toggle.setAttribute('aria-description', this.options.purpose); this.owner.focus(this) }
    this.draw(); if (state === 'open') this.fit(); this.owner.save()
    if (state !== 'open' && hadFocus) this.toggle.focus({ preventScroll: true })
  }
  /**
   * Take the height the content needs (header, content and the body's padding), where the window still follows its
   * content and is open to be measured. A person resizing it stops that; moving it doesn't; Reset layout restores it.
   */
  fit() {
    if (!this.placement.fit || this.options.camera || this.placement.state !== 'open' || this.owner.root.hidden) return
    const area = this.owner.area(), rect = this.placement.rect, pad = getComputedStyle(this.body)
    const natural = Math.ceil(this.header.offsetHeight + this.content.getBoundingClientRect().height + parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom) + 2)
    const portrait = this.owner.kind === 'portrait'
    const limits = { ...(this.options.limits ?? LIMITS), ...(portrait ? { maxH: Math.max(LIMITS.minH, Math.round(area.h * PORTRAIT_SHARE)) } : {}) }
    // A window standing on the bottom edge (a portrait phone's, the scores) keeps it and grows upward; one at the top
    // (a portrait phone's view controls) grows down.
    const standing = rect.y > area.y + 1 && (portrait || rect.y + rect.h >= area.y + area.h - 1)
    const next = fitHeight(rect, natural, area, limits, standing)
    if (Math.abs(next.h - rect.h) < 1 && Math.abs(next.y - rect.y) < 1) return
    this.placement.rect = next; this.draw()
  }
  draw() {
    const { rect, state } = this.placement
    this.element.hidden = state !== 'open'; this.element.dataset.state = state
    Object.assign(this.element.style, { transform: `translate(${rect.x}px, ${rect.y}px)`, width: `${rect.w}px`, height: `${rect.h}px` })
    this.toggle?.setAttribute('aria-pressed', String(state === 'open'))
    if (this.expand) {
      const big = !!this.restore || this.enlarged(), label = `${big ? 'Restore' : 'Enlarge'} ${this.options.title}`
      if (this.expand.getAttribute('aria-label') !== label) { this.expand.setAttribute('aria-label', label); this.expand.title = label; this.expand.replaceChildren(icon(big ? 'restore' : 'expand')) }
    }
    this.owner.changed()
  }
  private bindDrag(handle: HTMLElement, edge?: Edge) {
    let gesture: { id: number; x: number; y: number; rect: Rect } | null = null
    handle.addEventListener('pointerdown', e => {
      if (!e.isPrimary || e.button !== 0) return
      // The window comes to the front; keyboard focus stays where it was, so a drag leaves no focus ring behind.
      e.preventDefault(); e.stopPropagation(); this.owner.focus(this)
      gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, rect: { ...this.placement.rect } }; handle.setPointerCapture(e.pointerId)
      this.element.classList.add('panel-dragging')
    })
    handle.addEventListener('pointermove', e => {
      if (!gesture || gesture.id !== e.pointerId) return
      const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y, area = this.owner.area(), others = this.owner.others(this)
      this.placement.rect = edge ? resizeRect(gesture.rect, edge, dx, dy, area, this.options.limits, others) : clampRect(snapMove({ ...gesture.rect, x: gesture.rect.x + dx, y: gesture.rect.y + dy }, area, others), area, this.options.limits)
      if (edge) this.placement.fit = false
      this.restore = null; this.draw()
    })
    const finish = (e: PointerEvent) => {
      if (!gesture || e.pointerId !== gesture.id) return
      if (e.type === 'pointercancel') { this.placement.rect = clampRect(gesture.rect, this.owner.area(), this.options.limits); this.draw() }
      gesture = null; this.element.classList.remove('panel-dragging'); this.owner.save()
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
    }
    handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish); handle.addEventListener('lostpointercapture', finish)
  }
}

export class Panels {
  readonly root = document.createElement('div')
  readonly dock = document.createElement('nav')
  private items = document.createElement('div')
  private tooltip = document.createElement('div')
  private panels = new Map<string, SimPanel>()
  private order: SimPanel[] = []
  private storage: LayoutStorage | null = null
  kind = screenClass(innerWidth, innerHeight)
  private saved: Layout
  private frame = 0
  constructor(readonly sim: string) {
    try { this.storage = localStorage } catch { /* Storage can be blocked before getItem. */ }
    this.saved = readLayout(this.storage, layoutKey(sim, this.kind))
    document.body.classList.add('has-sim-panels')
    this.root.className = 'sim-windows'; this.dock.className = 'panel-dock'; this.dock.setAttribute('aria-label', 'Sim windows')
    this.items.className = 'panel-dock-items'; this.items.id = 'panel-dock-items'
    const help = document.createElement('p'); help.id = 'panel-help'; help.className = 'panel-sr'
    help.textContent = 'Drag the title to move. Drag any edge to resize. On the title, arrow keys move and Shift plus arrows resize. Escape closes. Reopen from the left dock.'
    // On touch screens the rail waits off the left edge behind this tab.
    const handle = button('Show window dock', 'dock'); handle.className = 'panel-dock-handle'; handle.setAttribute('aria-expanded', 'false'); handle.setAttribute('aria-controls', this.items.id)
    const reveal = (open: boolean) => { this.dock.dataset.open = String(open); handle.setAttribute('aria-expanded', String(open)) }
    handle.onclick = () => reveal(this.dock.dataset.open !== 'true')
    document.addEventListener('pointerdown', e => { if (!this.dock.contains(e.target as Node)) { reveal(false); if (this.dock.contains(document.activeElement)) (document.activeElement as HTMLElement).blur() } })
    this.dock.addEventListener('keydown', e => { if (e.key === 'Escape') { reveal(false); handle.focus(); e.stopPropagation() } })
    const reset = button('Reset layout', 'reset'); reset.className = 'panel-toggle panel-reset'; reset.removeAttribute('title'); reset.onclick = () => this.reset(); this.tip(reset, 'Reset layout', 'Put this sim’s windows back as they start on this screen')
    this.dock.append(handle, this.items, reset); this.tooltip.className = 'panel-tooltip'; this.tooltip.id = 'panel-tooltip'; this.tooltip.setAttribute('role', 'tooltip'); this.tooltip.hidden = true
    document.body.append(this.root, this.dock, help, this.tooltip)
    addEventListener('resize', () => this.resize()); window.visualViewport?.addEventListener('resize', () => this.resize())
    addEventListener('obpal:viewmode', e => {
      const xr = (e as CustomEvent<string>).detail === 'xr'
      this.root.hidden = this.dock.hidden = xr; this.tooltip.hidden = true
      if (!xr) this.resize()
    })
  }
  /** Where windows go: right of the dock's gutter (styles/panels.css), under the bar, clear of the safe areas. */
  area(): Rect {
    const style = getComputedStyle(this.dock), inset = (name: string) => parseFloat(style.getPropertyValue(name)) || 0
    const w = window.visualViewport?.width ?? innerWidth, h = window.visualViewport?.height ?? innerHeight
    const x = (inset('--panel-gutter') || 64) + inset('--panel-safe-left'), y = Math.max(72, document.querySelector('.sim-top')?.getBoundingClientRect().bottom ?? 0) + 12
    return { x, y, w: Math.max(1, w - x - 12 - inset('--panel-safe-right')), h: Math.max(1, h - y - 12 - inset('--panel-safe-bottom')) }
  }
  placement(options: PanelOptions): Placement {
    const defaults = this.default(options)
    const saved = this.saved[options.id]
    // A layout saved before windows fitted their content was placed by hand: it keeps its size.
    const p = saved ? { ...saved, fit: saved.fit ?? false } : { ...defaults, state: options.state ?? defaults.state }
    return { rect: clampRect(p.rect, this.area(), options.limits), state: p.state, fit: p.fit }
  }
  default(options: PanelOptions) { return defaultPlacement(options.anchor, options.index ?? 0, this.area(), this.kind) }
  add(content: HTMLElement, options: PanelOptions) {
    const old = this.panels.get(options.id)
    if (old) { old.replace(content); return old }
    // A device arriving must not cover the controls the viewer is already using.
    const front = this.order.at(-1)
    const p = new SimPanel(this, content, options); this.panels.set(options.id, p); this.order.push(p)
    this.root.append(p.element); this.items.append(p.toggle); this.focus(front ?? p); p.fit(); return p
  }
  remove(id: string) {
    const p = this.panels.get(id); if (!p) return
    p.element.remove(); p.toggle.remove(); this.panels.delete(id); this.order = this.order.filter(x => x !== p)
    const front = this.order.at(-1); if (front) this.focus(front)
  }
  get(id: string) { return this.panels.get(id) }
  collapseDock() { this.dock.dataset.open = 'false'; this.dock.querySelector('.panel-dock-handle')?.setAttribute('aria-expanded', 'false') }
  focus(p: SimPanel) {
    if (this.order.at(-1) === p && p.element.dataset.focused === 'true') return
    this.order = this.order.filter(x => x !== p); this.order.push(p)
    this.order.forEach((panel, i) => { panel.element.style.zIndex = String(i + 1); panel.element.dataset.focused = String(panel === p) })
  }
  others(p: SimPanel) { return [...this.panels.values()].filter(other => other !== p && other.visible).map(other => other.placement.rect) }
  /** A glass tooltip beside a dock button: its name, and what it's for. */
  tip(button: HTMLButtonElement, title: string, purpose: string) {
    const show = () => {
      const r = button.getBoundingClientRect(), rail = this.dock.getBoundingClientRect()
      const name = document.createElement('b'), what = document.createElement('span')
      name.textContent = title; what.textContent = purpose
      this.tooltip.replaceChildren(name, what); this.tooltip.hidden = false
      this.tooltip.style.left = `${Math.round(Math.max(rail.right, r.right) + 10)}px`
      this.tooltip.style.top = `${Math.round(Math.min(innerHeight - this.tooltip.offsetHeight - 8, Math.max(8, r.top + r.height / 2 - this.tooltip.offsetHeight / 2)))}px`
      button.setAttribute('aria-describedby', this.tooltip.id)
    }
    const hide = () => { this.tooltip.hidden = true; button.removeAttribute('aria-describedby') }
    button.addEventListener('pointerenter', show); button.addEventListener('focus', show); button.addEventListener('pointerleave', hide); button.addEventListener('blur', hide); button.addEventListener('click', hide)
  }
  changed() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => { this.frame = 0; dispatchEvent(new Event('obpal:panels')) })
  }
  save() {
    for (const [id, p] of this.panels) this.saved[id] = { rect: { ...p.placement.rect }, state: p.placement.state, fit: !!p.placement.fit }
    writeLayout(this.storage, layoutKey(this.sim, this.kind), this.saved)
  }
  reset() {
    clearLayout(this.storage, layoutKey(this.sim, this.kind)); this.saved = Object.create(null)
    for (const p of this.panels.values()) p.reset()
    this.save()
  }
  private resize() {
    const kind = screenClass(innerWidth, innerHeight)
    if (kind !== this.kind) {
      this.save(); this.kind = kind; this.saved = readLayout(this.storage, layoutKey(this.sim, kind))
      for (const p of this.panels.values()) p.reset()
    }
    for (const p of this.panels.values()) { p.placement.rect = clampRect(p.placement.rect, this.area(), p.options.limits ?? LIMITS); p.draw(); p.fit() }
  }
}

let current: Panels | null = null
export function simPanels(sim?: string) {
  if (!current) {
    const params = new URLSearchParams(location.search)
    current = new Panels(sim ?? `${location.pathname}:${params.get('d') ?? params.get('kind') ?? ''}`)
  }
  return current
}

/** A panel's sections, numbered in order as widget cards are ("01 View"), skipping any that left for a window of their own. */
export function numberSections(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>(':is(.sim-sec, .sim-sound, .studio-audio):not([hidden]) > .kit-card-head .kit-card-n')
    .forEach((n, i) => { n.textContent = String(i + 1).padStart(2, '0') })
}

/** Shared control card and its optional log. Contextual dialogs and pairing keep their own lifetimes. */
export function mountSimPanels(sim: string, title: string) {
  const panels = simPanels(sim), controls = document.querySelector<HTMLElement>('.sim-panel')!
  panels.add(controls, { id: 'controls', title, purpose: 'Devices, seats, view, sound and scene controls', icon: 'controls', anchor: 'controls' })
  const log = controls.querySelector<HTMLDetailsElement>('.log-wrap')
  if (log) { log.open = true; panels.add(log, { id: 'record', title: 'Activity record', purpose: 'Who held what and what happened in the scene', icon: 'record', anchor: 'record' }) }
  return panels
}
