/**
 * The segmented icon control: a row of choices, one chosen, the chosen one lit with the accent ring. As `tiles` it
 * wraps into a grid of larger tiles (an icon over a name and a count), for a filter sheet or a device's seats. It's a
 * radio group: Tab reaches the chosen item, the arrow keys move and choose, Home and End jump, disabled items are passed
 * over. With `iconOnly` the names become tooltips (and stay the items' accessible names).
 */
import { type Content, html, setMarkup } from '../markup'
import { edge, step } from './listnav'
import '../../styles/kit.css'

export interface SegmentItem {
  value: string
  label: string
  icon?: Content
  /** A count or a short note under (tiles) or beside the name. */
  badge?: string | number
  disabled?: boolean
}

export interface SegmentedOptions {
  /** The group's name. */
  label: string
  items: readonly SegmentItem[]
  value: string
  /** A person chose `value`. */
  onChange?: (value: string) => void
  /** Icons alone, names in tooltips. */
  iconOnly?: boolean
  /** A grid of tiles rather than a row. */
  tiles?: boolean
  className?: string
}

export class Segmented {
  readonly el: HTMLDivElement
  private items: SegmentItem[]
  private current: string

  constructor(private opts: SegmentedOptions) {
    this.items = [...opts.items]
    this.current = opts.value
    const el = this.el = document.createElement('div')
    el.className = ['kit-seg', opts.tiles ? 'kit-tiles' : '', opts.iconOnly ? 'kit-seg-icons' : '', opts.className].filter(Boolean).join(' ')
    el.setAttribute('role', 'radiogroup')
    el.setAttribute('aria-label', opts.label)
    el.addEventListener('click', (e) => {
      const i = this.indexAt(e.target)
      if (i >= 0 && !this.items[i].disabled) this.choose(i, false)
    })
    el.addEventListener('keydown', (e) => this.key(e))
    this.render()
  }

  get value() { return this.current }
  /** Set from code: onChange isn't called. */
  set value(v: string) { if (v !== this.current) { this.current = v; this.sync() } }

  /** New items (counts, disabled), and optionally a value. */
  setItems(items: readonly SegmentItem[], value = this.current) {
    const same = items.length === this.items.length && items.every((it, i) => it.value === this.items[i].value && it.label === this.items[i].label && it.icon === this.items[i].icon)
    this.items = [...items]
    this.current = value
    if (same) this.sync()
    else this.render()
  }

  focus() { this.buttons()[Math.max(0, this.chosen())]?.focus() }

  private buttons() { return [...this.el.querySelectorAll<HTMLButtonElement>('[role="radio"]')] }
  private chosen() { return this.items.findIndex((i) => i.value === this.current) }
  private indexAt(t: EventTarget | null) {
    const b = (t as Element | null)?.closest?.('[role="radio"]') as HTMLElement | null
    return b ? Number(b.dataset.i) : -1
  }

  private key(e: KeyboardEvent) {
    const from = this.indexAt(e.target)
    if (from < 0) return
    let to = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = step(this.items, from, 1, { wrap: true })
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = step(this.items, from, -1, { wrap: true })
    else if (e.key === 'Home') to = edge(this.items, 'first')
    else if (e.key === 'End') to = edge(this.items, 'last')
    else if (e.key === ' ' || e.key === 'Enter') to = from
    else return
    e.preventDefault()
    if (to >= 0) this.choose(to, true)
  }

  private choose(i: number, focus: boolean) {
    const item = this.items[i]
    if (!item || item.disabled) return
    const changed = item.value !== this.current
    this.current = item.value
    this.sync()
    if (focus) this.buttons()[i]?.focus()
    if (changed) this.opts.onChange?.(item.value)
  }

  private render() {
    const tiles = !!this.opts.tiles
    setMarkup(this.el, this.items.map((item, i) => html`<button type="button" class="kit-seg-item" role="radio" data-i="${i}" data-value="${item.value}" aria-checked="false"><span class="kit-seg-ic" aria-hidden="true">${item.icon ?? ''}</span><span class="kit-seg-label">${item.label}</span>${tiles ? html`<span class="kit-seg-badge"></span>` : ''}</button>`))
    this.sync()
  }

  /** Chosen, disabled, counts, tab stop and tooltips, without rebuilding. */
  private sync() {
    const chosen = this.chosen()
    const stop = chosen >= 0 && !this.items[chosen].disabled ? chosen : edge(this.items, 'first')
    this.buttons().forEach((b, i) => {
      const item = this.items[i]
      if (!item) return
      b.setAttribute('aria-checked', String(i === chosen))
      b.disabled = !!item.disabled && i !== chosen
      b.tabIndex = i === stop ? 0 : -1
      if (this.opts.iconOnly) { b.setAttribute('aria-label', item.label); b.dataset.tip = item.label }
      const badge = b.querySelector('.kit-seg-badge')
      if (badge) badge.textContent = item.badge === undefined || item.badge === null ? '' : String(item.badge)
    })
  }
}
