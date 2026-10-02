/**
 * The node strip (PROTOCOL §3a): along the trackpad's edge, a thin scrollable column of icons for what the node you
 * hold offers: the whole of it, its sets, then its parts one by one, with the one the trackpad drives lit. A tap, or a
 * swipe along the strip, switches (a tick each time); a long press locks a part (a lock glyph) or frees it. The strip
 * keeps its touches to itself, so a finger held on the pad carries straight on with the new choice.
 */
import { LOCKS_VALUE, MAX_PARTS, MAX_SETS, PART_VALUE, type SceneNode } from '@obpal/core'
import { icon, ICONS } from '../ui/icons'
import { html, setMarkup } from '../ui/markup'
import { toUi, uiRect } from './uiframe'
import { fitControlInk } from '../ui/kit/ink'

export interface StripItem {
  /** '' for the whole node, else a set's or a part's id. */
  id: string
  name: string
  icon: string
  kind: 'whole' | 'set' | 'part'
  /** The parts it drives: a set's, a part's own, none for the whole. */
  parts: readonly string[]
  /** A set that holds the node's other parts while it's chosen. */
  locks: boolean
}

/** A press this long on a part locks or frees it (as a long press anywhere on the phone does). */
export const LONG_PRESS_MS = 420
/** Moved this far along the strip, a press is a swipe (it picks what's under the finger). */
const SWIPE_PX = 6
/** Moved this far across it first, a press was a drag meant for the pad: it picks nothing. */
const LEAVE_PX = 16
/** Held this near an end of a strip with more beyond it, the strip scrolls on (px from the end, px a frame). */
const EDGE_PX = 30
const EDGE_STEP = 6

/** What the strip lists for a node: the whole of it, its sets of two or more of its parts, then each part. Pure. */
export function stripItems(node: SceneNode | null | undefined): StripItem[] {
  const parts = (Array.isArray(node?.parts) ? node!.parts : []).slice(0, MAX_PARTS).filter((p) => p && typeof p.id === 'string' && p.id && typeof p.name === 'string')
  if (!node || parts.length < 2) return []
  const ids = parts.map((p) => p.id)
  const sets = (Array.isArray(node.sets) ? node.sets : []).slice(0, MAX_SETS)
    .filter((s) => s && typeof s.id === 'string' && s.id && !ids.includes(s.id) && Array.isArray(s.parts))
    .map((s) => ({ ...s, parts: s.parts.filter((id) => ids.includes(id)) }))
    .filter((s) => s.parts.length > 1)
  return [
    { id: '', name: node.name, icon: node.icon ?? 'whole', kind: 'whole', parts: [], locks: false },
    ...sets.map((s): StripItem => ({ id: s.id, name: s.name, icon: s.icon ?? 'models', kind: 'set', parts: s.parts, locks: !!s.locks })),
    ...parts.map((p): StripItem => ({ id: p.id, name: p.name, icon: p.icon ?? '', kind: 'part', parts: [p.id], locks: false })),
  ]
}

/** What a choice lights on the strip and what it holds: the parts driven, and those locked (by hand, or by a set). Pure. */
export function stripState(items: readonly StripItem[], chosen: string, locks: readonly string[]): { item: StripItem | null; lit: Set<string>; held: Set<string> } {
  const item = items.find((i) => i.id === chosen) ?? items[0] ?? null
  const held = new Set(locks.filter((id) => items.some((i) => i.kind === 'part' && i.id === id)))
  if (item?.locks) for (const i of items) if (i.kind === 'part' && !item.parts.includes(i.id)) held.add(i.id)
  const lit = new Set((item?.parts ?? []).filter((id) => !held.has(id)))
  return { item, lit, held }
}

export interface StripDeps {
  /** Tell the screen (value{control.part} and value{control.locks}). */
  send(id: string, v: string): void
  /** A tick for a switch; a strong one for a lock. */
  feel(strong?: boolean): void
  /** The choice changed here (the pad's legend follows it). */
  changed(): void
}

export class NodeStrip {
  el: HTMLElement | null = null
  private list: HTMLElement | null = null
  private tag: HTMLElement | null = null
  private items: StripItem[] = []
  private chosen = ''
  private locks: string[] = []
  /** What this phone sent and the screen hasn't confirmed yet: shown meanwhile, so a switch never flickers back. */
  private sent: { part?: string; locks?: string; at: number } = { at: 0 }
  private shown = false
  private drawn = ''
  private tagTimer: ReturnType<typeof setTimeout> | undefined
  private press: { id: number; item: string; at: number; moved: boolean; locked: boolean; timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null
  private edge = 0
  private releaseInk: (() => void) | undefined

  constructor(private deps: StripDeps) {}

  html() {
    return html`<div class="nstrip" id="nstrip" role="toolbar" aria-label="What the trackpad moves" aria-orientation="vertical" hidden><div class="ns-list"></div></div><div class="ns-tag glass" id="ns-tag" aria-hidden="true"></div>`
  }

  mount(root: ParentNode) {
    this.el = root.querySelector<HTMLElement>('#nstrip')
    this.list = this.el?.querySelector<HTMLElement>('.ns-list') ?? null
    this.tag = root.querySelector<HTMLElement>('#ns-tag')
    this.drawn = ''
    const el = this.el
    this.releaseInk?.(); this.releaseInk = undefined
    if (!el) return
    this.releaseInk = fitControlInk(el)
    this.list?.addEventListener('scroll', () => this.edges(), { passive: true })
    // A turn or a resize changes what fits as much as a scroll does.
    if (this.list && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.edges()).observe(this.list)
    // The strip sits on the trackpad, which takes every pointer it sees: its touches stay here.
    el.addEventListener('pointerdown', this.down)
    el.addEventListener('pointermove', this.move)
    el.addEventListener('pointerup', this.up)
    el.addEventListener('pointercancel', this.cancel)
    // The strip's own capture ends here: bubbling on, it would end the pad's hold on a drag handed to it (below).
    el.addEventListener('lostpointercapture', (e) => { e.stopPropagation(); this.cancel() })
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    el.addEventListener('click', (e) => {
      // A click from a keyboard or an assistive tool (a touch's own click is handled on the way up).
      const b = (e.target as Element).closest<HTMLElement>('.ns-item')
      if (b && e.detail === 0) this.pick(b.dataset.part ?? '')
    })
    el.addEventListener('keydown', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('.ns-item')
      if (!b) return
      const at = this.buttons().indexOf(b)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = this.buttons()[at + (e.key === 'ArrowDown' ? 1 : -1)]
        if (next) { next.focus(); this.pick(next.dataset.part ?? '') }
      } else if (e.key === 'l' || e.key === 'L') this.toggleLock(b.dataset.part ?? '')
    })
  }

  /** What's chosen now: the item and the parts it drives (null while the strip isn't showing). */
  get current(): { item: StripItem | null; lit: Set<string>; held: Set<string> } | null {
    return this.shown ? stripState(this.items, this.chosen, this.locks) : null
  }

  /**
   * The pad's legend for a part or a set: which gesture moves which part, as the screen reads them (the first across,
   * the second up and down, a third and fourth with two fingers; a part alone takes the drag either way). Empty for
   * the whole node, which keeps the pad's own legend.
   */
  legend(): { gesture: string; name: string }[] {
    const c = this.current
    if (!c?.item || c.item.kind === 'whole') return []
    const named = (id: string) => this.items.find((i) => i.kind === 'part' && i.id === id)?.name ?? id
    if (c.item.parts.length === 1) return c.held.has(c.item.parts[0]) ? [] : [{ gesture: 'drag', name: named(c.item.parts[0]) }]
    return c.item.parts.slice(0, 4).flatMap((id, k) => c.held.has(id) ? [] : [{ gesture: ['swipe-x', 'swipe-y', 'pan-y', 'pan-x'][k], name: named(id) }])
  }

  /**
   * The node held now, and what the screen confirmed (its `control.part` and `control.locks` values; absent from a
   * screen that doesn't know them). `show`: the trackpad is the face in use. Redraws only when something changed.
   */
  sync(node: SceneNode | null, values: Record<string, unknown>, show: boolean) {
    const items = stripItems(node)
    const key = JSON.stringify(items)
    if (key !== JSON.stringify(this.items)) {
      this.items = items
      this.chosen = ''
      this.locks = []
      this.sent = { at: 0 }
    }
    // The screen has the last word: what it confirmed (a choice it didn't take, a reset when you took another node).
    // What this phone just sent stands until the screen answers it, or for a moment if it never does.
    const waiting = performance.now() - this.sent.at < 1500
    const part = values[PART_VALUE], locks = values[LOCKS_VALUE]
    if (typeof part === 'string' && !(waiting && this.sent.part !== undefined && part !== this.sent.part)) {
      if (items.some((i) => i.id === part)) this.chosen = part
      if (part === this.sent.part) delete this.sent.part
    }
    if (typeof locks === 'string' && !(waiting && this.sent.locks !== undefined && locks !== this.sent.locks)) {
      this.locks = locks.split(',').filter((id) => items.some((i) => i.kind === 'part' && i.id === id))
      if (locks === this.sent.locks) delete this.sent.locks
    }
    this.shown = show && items.length > 0
    this.draw()
  }

  /** Forget the node (the connection changed): nothing shows until the next scene says what's held. */
  reset() {
    this.items = []
    this.chosen = ''
    this.locks = []
    this.shown = false
    this.cancel()
    this.draw()
  }

  private buttons() { return [...(this.list?.querySelectorAll<HTMLElement>('.ns-item') ?? [])] }

  /** A long strip fades at an end with more beyond it (controller.css), so a part cut off there reads as scrolled away. */
  private edges() {
    const l = this.list
    if (!l) return
    l.classList.toggle('up', l.scrollTop > 1)
    l.classList.toggle('down', l.scrollHeight - l.clientHeight - l.scrollTop > 1)
  }

  private draw() {
    const el = this.el
    if (!el || !this.list) return
    el.hidden = !this.shown
    el.closest('.pad')?.classList.toggle('stripped', this.shown)
    if (!this.shown) return
    const { lit, held, item } = stripState(this.items, this.chosen, this.locks)
    const key = JSON.stringify([this.items, this.chosen, [...held]])
    if (key === this.drawn) return
    const first = !this.drawn
    this.drawn = key
    const glyph = (i: StripItem) => icon(i.icon) || html`<b class="ns-mono">${i.name.slice(0, 1).toUpperCase()}</b>`
    setMarkup(this.list, this.items.map((i, n) => html`${i.kind === 'part' && this.items[n - 1]?.kind !== 'part' ? html`<i class="ns-sep" aria-hidden="true"></i>` : ''}<button type="button" class="ns-item" data-part="${i.id}" data-kind="${i.kind}" aria-pressed="${i === item}" aria-label="${i.name}${held.has(i.id) ? ', locked' : ''}" title="${i.name}">${glyph(i)}${i.kind === 'set' ? html`<i class="ns-count" aria-hidden="true">${i.parts.slice(0, 4).map(() => html`<b></b>`)}</i>` : ''}<i class="ns-lock" aria-hidden="true">${ICONS.lock}</i></button>`))
    for (const b of this.buttons()) {
      const id = b.dataset.part ?? ''
      b.classList.toggle('in', b.dataset.kind === 'part' && lit.has(id) && item?.kind !== 'part')
      b.classList.toggle('held', held.has(id))
      b.tabIndex = b.getAttribute('aria-pressed') === 'true' ? 0 : -1
    }
    // The chosen one in view (a long list scrolls), at once the first time.
    const on = this.list.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (on) {
      // The list is the buttons' offset parent (controller.css).
      const top = on.offsetTop, bottom = top + on.offsetHeight
      const to = top < this.list.scrollTop ? top - 8 : bottom > this.list.scrollTop + this.list.clientHeight ? bottom - this.list.clientHeight + 8 : null
      if (to !== null) this.list.scrollTo({ top: to, behavior: first ? 'auto' : 'smooth' })
    }
    requestAnimationFrame(() => this.edges())
  }

  /** Choose an item: the pad drives it from the next frame on. */
  private pick(id: string) {
    if (!this.items.some((i) => i.id === id) || id === this.chosen) return
    this.chosen = id
    this.sent = { ...this.sent, part: id, at: performance.now() }
    this.deps.send(PART_VALUE, id)
    this.deps.feel()
    this.draw()
    this.say(this.items.find((i) => i.id === id)!, false)
    this.deps.changed()
  }

  private toggleLock(id: string) {
    if (!this.items.some((i) => i.kind === 'part' && i.id === id)) return
    const on = !this.locks.includes(id)
    this.locks = on ? [...this.locks, id] : this.locks.filter((x) => x !== id)
    this.sent = { ...this.sent, locks: this.locks.join(','), at: performance.now() }
    this.deps.send(LOCKS_VALUE, this.locks.join(','))
    this.deps.feel(true)
    this.draw()
    this.say(this.items.find((i) => i.id === id)!, on)
    this.deps.changed()
  }

  /** The chosen item's name, a moment beside the strip (and a lock with it, when that's what changed). */
  private say(item: StripItem, locked: boolean) {
    const tag = this.tag
    if (!tag || !this.list) return
    setMarkup(tag, html`${locked ? ICONS.lock : ''}<span></span>`)
    tag.querySelector('span')!.textContent = item.name
    const b = this.list.querySelector<HTMLElement>(`.ns-item[data-part="${CSS.escape(item.id)}"]`)
    const pad = this.el?.closest('.pad')
    if (b && pad) {
      const r = uiRect(b), p = uiRect(pad)
      tag.style.setProperty('--y', `${r.top - p.top + r.height / 2}px`)
    }
    tag.classList.add('in')
    clearTimeout(this.tagTimer)
    this.tagTimer = setTimeout(() => tag.classList.remove('in'), 900)
  }

  /** The item under the finger; between two (or on the rail's rim), the nearest along the strip. */
  private itemAt(e: PointerEvent): HTMLElement | null {
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.ns-item')
    if (hit && this.list?.contains(hit)) return hit
    const { y } = toUi(e.clientX, e.clientY)
    let best: HTMLElement | null = null
    let gap = Infinity
    for (const b of this.buttons()) {
      const r = uiRect(b), d = Math.abs(r.top + r.height / 2 - y)
      if (d < gap) { gap = d; best = b }
    }
    return best
  }

  private down = (e: PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (this.press) return
    const b = this.itemAt(e)
    if (!b) return
    try { this.el!.setPointerCapture(e.pointerId) } catch { /* synthetic events */ }
    const id = b.dataset.part ?? ''
    // Held on a part, the press locks it or frees it; held on the whole or a set, it's a tap that took its time.
    const timer = setTimeout(() => {
      const p = this.press
      if (!p || p.moved || !this.items.some((i) => i.kind === 'part' && i.id === p.item)) return
      p.locked = true
      this.toggleLock(p.item)
    }, LONG_PRESS_MS)
    const at = toUi(e.clientX, e.clientY)
    if (this.list) this.list.style.scrollSnapType = 'none'
    this.press = { id: e.pointerId, item: id, at: performance.now(), moved: false, locked: false, timer, x: at.x, y: at.y }
    b.classList.add('down')
  }

  private move = (e: PointerEvent) => {
    const p = this.press
    if (!p || e.pointerId !== p.id) return
    e.stopPropagation()
    const { x, y } = toUi(e.clientX, e.clientY)
    // Off across the strip before along it: a drag begun on its edge, meant for the pad. It picks nothing here, and
    // carries on as the pad's own drag from where the finger is.
    if (!p.moved && Math.abs(x - p.x) > LEAVE_PX && Math.abs(x - p.x) > Math.abs(y - p.y)) {
      this.cancel()
      try { this.el?.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
      this.el?.closest('.pad')?.dispatchEvent(new PointerEvent('pointerdown', { pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary, clientX: e.clientX, clientY: e.clientY }))
      return
    }
    if (!p.moved && Math.abs(y - p.y) < SWIPE_PX) return
    if (!p.moved) { p.moved = true; clearTimeout(p.timer); this.list?.querySelector('.ns-item.down')?.classList.remove('down') }
    // A swipe picks what's under the finger as it goes.
    const b = this.itemAt(e)
    if (b) this.pick(b.dataset.part ?? '')
    this.scrollNear(y)
  }

  /** Held near an end with more beyond it, the strip scrolls on, a little each frame, until the finger moves off. */
  private scrollNear(y: number) {
    const list = this.list
    if (!list) return
    const r = uiRect(list)
    const dir = y < r.top + EDGE_PX ? -1 : y > r.top + r.height - EDGE_PX ? 1 : 0
    cancelAnimationFrame(this.edge)
    if (!dir) return
    const step = () => {
      if (!this.press?.moved) return
      const before = list.scrollTop
      list.scrollTop += dir * EDGE_STEP
      if (list.scrollTop !== before) this.edge = requestAnimationFrame(step)
    }
    this.edge = requestAnimationFrame(step)
  }

  private up = (e: PointerEvent) => {
    const p = this.press
    if (!p || e.pointerId !== p.id) return
    e.stopPropagation()
    this.press = null
    clearTimeout(p.timer)
    cancelAnimationFrame(this.edge)
    if (this.list) this.list.style.scrollSnapType = ''
    this.list?.querySelector('.ns-item.down')?.classList.remove('down')
    // A tap picks what it landed on; a long press has locked it already, a swipe picked as it went.
    if (!p.moved && !p.locked) this.pick(p.item)
  }

  private cancel = () => {
    const p = this.press
    this.press = null
    if (p) clearTimeout(p.timer)
    cancelAnimationFrame(this.edge)
    if (this.list) this.list.style.scrollSnapType = ''
    this.list?.querySelector('.ns-item.down')?.classList.remove('down')
  }
}
