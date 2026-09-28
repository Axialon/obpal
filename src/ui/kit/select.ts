/**
 * The glass select: a frosted, rounded list that opens from a button, never the operating system's own. Each option
 * can carry an icon, a count and a second line, be disabled, and sit under a group heading. It is the ARIA select-only
 * combobox: focus stays on the button while the arrow keys, Home, End, Page Up and Page Down move through the list,
 * typing a name jumps to it, Enter, Space, Tab or Alt+Up chooses, and Escape closes without choosing. A mouse points
 * and clicks; a finger taps, and scrolls a long list.
 *
 * enhanceSelect() puts one over a native <select>, which stays the value's home for the page's own code: setting its
 * value or its options shows at once, and choosing fires its input and change events. enhanceSelects() does that for
 * every <select> on a page, as they arrive; `data-native` keeps one as it is.
 *
 * Inside a collapsed rail the button shows only its icon and the list opens beside it: the rail sets `--kit-pop:
 * beside` (see styles/kit.css).
 */
import { type Content, html, setMarkup } from '../markup'
import { ICONS } from '../icons'
import { edge, printable, step, Typeahead, typeahead } from './listnav'
import { placePopover, popoverFrame } from './place'
import '../../styles/kit.css'

export interface SelectItem {
  value: string
  label: string
  /** An icon's markup: a ../icons.ts glyph, or a template. */
  icon?: Content
  /** A count or a short note, in a badge at the row's end. */
  badge?: string | number
  /** A quieter second line. */
  hint?: string
  disabled?: boolean
  /** The heading it sits under; neighbours with the same heading share one. */
  group?: string
}

export interface SelectOptions {
  /** The control's name, for assistive tech and the rail's tooltip. */
  label: string
  items: readonly SelectItem[]
  value?: string
  /** A person chose `value` (code setting it doesn't call this). */
  onChange?: (value: string) => void
  /** Class names for the button, beside kit-select. */
  className?: string
  id?: string
  /** What the button says when no option has the value. */
  placeholder?: string
}

let seq = 0
/** The open list, if any: opening another closes it. */
let openSelect: GlassSelect | null = null
/** Page Up and Page Down move this many options. */
const PAGE = 10
/** The tallest a list grows before it scrolls. */
const MAX_LIST = 420
const hasBadge = (b: SelectItem['badge']) => b !== undefined && b !== null && b !== ''
/** What a list of options shows, as a string: equal strings, the same list. */
const signature = (items: readonly SelectItem[]) =>
  JSON.stringify(items.map((i) => [i.value, i.label, !!i.disabled, i.group ?? '', i.badge ?? '', i.hint ?? '', typeof i.icon === 'string' ? i.icon : i.icon ? '*' : '']))

export class GlassSelect {
  readonly button: HTMLButtonElement
  readonly list: HTMLDivElement
  private items: SelectItem[]
  private current: string
  private active = -1
  private shown = ''
  private readonly typed = new Typeahead()
  private readonly id = `kit-select-${++seq}`
  private readonly placeholder: string
  private readonly onChange?: (value: string) => void
  private keyAt = -Infinity
  private raf = 0
  private listed = ''
  private readonly outside = (e: Event) => {
    const t = e.target as Node | null
    if (t && !this.button.contains(t) && !this.list.contains(t)) this.close()
  }
  /** The list follows its button as the page scrolls or resizes (its own scrolling moves nothing). */
  private readonly follow = (e?: Event) => {
    if (this.raf || e?.target === this.list) return
    this.raf = requestAnimationFrame(() => { this.raf = 0; if (this.isOpen) this.place() })
  }

  constructor(opts: SelectOptions) {
    this.placeholder = opts.placeholder ?? opts.label
    this.onChange = opts.onChange
    this.items = [...opts.items]
    this.listed = signature(this.items)
    this.current = opts.value ?? this.items.find((i) => !i.disabled)?.value ?? ''
    const b = this.button = document.createElement('button')
    b.type = 'button'
    b.className = ['kit-select', opts.className].filter(Boolean).join(' ')
    if (opts.id) b.id = opts.id
    b.setAttribute('role', 'combobox')
    b.setAttribute('aria-haspopup', 'listbox')
    b.setAttribute('aria-expanded', 'false')
    b.setAttribute('aria-controls', `${this.id}-list`)
    const l = this.list = document.createElement('div')
    l.className = 'kit-pop kit-listbox'
    l.id = `${this.id}-list`
    l.setAttribute('role', 'listbox')
    l.tabIndex = -1
    l.dataset.kitPopover = ''
    this.label = opts.label
    this.renderButton()
    b.addEventListener('click', (e) => {
      // Enter and Space are handled as keys; the click a key makes of them is not a second press.
      if (e.detail === 0 && performance.now() - this.keyAt < 400) return
      if (this.isOpen) this.close()
      else this.open()
    })
    b.addEventListener('keydown', (e) => this.key(e))
    // A button clicks itself as Space or Enter comes up: that click was the key's, already handled.
    b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') this.keyAt = performance.now() })
    b.addEventListener('blur', () => setTimeout(() => { if (this.isOpen && document.activeElement !== b) this.close() }))
    // Pointing chooses while the button keeps the focus, so the keys go on working.
    l.addEventListener('pointerdown', (e) => e.preventDefault())
    l.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return
      const i = this.indexAt(e.target)
      if (i >= 0 && !this.items[i].disabled && i !== this.active) this.setActive(i, false)
    })
    l.addEventListener('click', (e) => {
      const i = this.indexAt(e.target)
      if (i >= 0 && !this.items[i].disabled) this.choose(i)
    })
  }

  /** The control's name. */
  get label() { return this.button.getAttribute('aria-label') ?? '' }
  set label(v: string) {
    this.button.setAttribute('aria-label', v)
    this.list.setAttribute('aria-label', v)
    this.shown = ''
  }

  get value() { return this.current }
  /** Set the value from code: the button shows it; onChange isn't called. */
  set value(v: string) {
    if (v === this.current) return
    this.current = v
    this.renderButton()
    if (this.isOpen) this.renderList()
  }

  get isOpen() { return this.button.getAttribute('aria-expanded') === 'true' }
  get disabled() { return this.button.disabled }
  set disabled(v: boolean) { this.button.disabled = v; if (v) this.close() }

  /** New options (and optionally a value), keeping the open list open. The same options again change nothing. */
  setItems(items: readonly SelectItem[], value = this.current) {
    const listed = signature(items)
    if (listed === this.listed && value === this.current) return
    this.listed = listed
    const activeValue = this.items[this.active]?.value
    this.items = [...items]
    this.current = value
    this.renderButton()
    if (!this.isOpen) return
    this.renderList()
    const i = this.items.findIndex((item) => item.value === activeValue)
    this.setActive(i >= 0 && !this.items[i].disabled ? i : this.selectedIndex(), false)
    this.place()
  }

  focus(options?: FocusOptions) { this.button.focus(options) }

  /** Open the list at the chosen option (or the first or last), as Down, Home or End does. */
  open(at: 'chosen' | 'first' | 'last' = 'chosen') {
    if (this.button.disabled) return
    if (!this.isOpen) {
      openSelect?.close()
      openSelect = this
      this.renderList()
      const host = this.button.closest('dialog[open]') ?? document.body
      host.append(this.list)
      this.button.setAttribute('aria-expanded', 'true')
      document.addEventListener('pointerdown', this.outside, true)
      addEventListener('resize', this.follow)
      addEventListener('scroll', this.follow, true)
      this.place()
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) this.list.animate(
        [{ opacity: 0, transform: `translateY(${this.list.dataset.side === 'above' ? 4 : -4}px) scale(0.985)` }, { opacity: 1, transform: 'none' }],
        { duration: 160, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      )
    }
    this.setActive(at === 'first' ? edge(this.items, 'first') : at === 'last' ? edge(this.items, 'last') : this.selectedIndex())
  }

  close() {
    if (!this.isOpen) return
    if (openSelect === this) openSelect = null
    document.removeEventListener('pointerdown', this.outside, true)
    removeEventListener('resize', this.follow)
    removeEventListener('scroll', this.follow, true)
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.list.remove()
    this.button.setAttribute('aria-expanded', 'false')
    this.button.removeAttribute('aria-activedescendant')
    this.active = -1
    this.typed.reset()
  }

  private selectedIndex() {
    const i = this.items.findIndex((item) => item.value === this.current)
    return i >= 0 && !this.items[i].disabled ? i : edge(this.items, 'first')
  }

  private indexAt(target: EventTarget | null) {
    const el = (target as Element | null)?.closest?.('[role="option"]') as HTMLElement | null
    return el ? Number(el.dataset.i) : -1
  }

  private key(e: KeyboardEvent) {
    const now = performance.now()
    if (!this.isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.keyAt = now; this.open() }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); this.open(e.key === 'Home' ? 'first' : 'last') }
      else if (printable(e)) { e.preventDefault(); this.open(); this.type(e.key, now) }
      return
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (!e.altKey) this.setActive(step(this.items, this.active, 1)); return
      case 'ArrowUp': e.preventDefault(); if (e.altKey) this.choose(this.active); else this.setActive(step(this.items, this.active, -1)); return
      case 'Home': e.preventDefault(); this.setActive(edge(this.items, 'first')); return
      case 'End': e.preventDefault(); this.setActive(edge(this.items, 'last')); return
      case 'PageDown': e.preventDefault(); this.setActive(step(this.items, this.active, 1, { count: PAGE })); return
      case 'PageUp': e.preventDefault(); this.setActive(step(this.items, this.active, -1, { count: PAGE })); return
      case 'Enter': e.preventDefault(); this.keyAt = now; this.choose(this.active); return
      case 'Escape': e.preventDefault(); e.stopPropagation(); this.close(); return
      // Tab chooses the option in view, and focus moves on as usual.
      case 'Tab': this.choose(this.active); return
      case ' ':
        e.preventDefault()
        this.keyAt = now
        if (this.typed.typing(now)) this.type(' ', now)
        else this.choose(this.active)
        return
    }
    if (printable(e)) { e.preventDefault(); this.type(e.key, now) }
  }

  private type(key: string, now: number) {
    const query = this.typed.push(key, now)
    const i = typeahead(this.items.map((item) => item.label), query, this.active, this.items.map((item) => !!item.disabled))
    if (i >= 0) this.setActive(i)
  }

  private choose(i: number) {
    const item = this.items[i]
    this.close()
    if (!item || item.disabled || item.value === this.current) return
    this.current = item.value
    this.renderButton()
    this.onChange?.(item.value)
  }

  private setActive(i: number, scroll = true) {
    this.active = i
    for (const el of this.list.querySelectorAll<HTMLElement>('[role="option"]')) el.classList.toggle('kit-active', Number(el.dataset.i) === i)
    const el = i >= 0 ? this.list.querySelector<HTMLElement>(`[data-i="${i}"]`) : null
    if (!el) { this.button.removeAttribute('aria-activedescendant'); return }
    this.button.setAttribute('aria-activedescendant', el.id)
    if (!scroll) return
    // Only the list scrolls, never the page behind it.
    const top = el.offsetTop, bottom = top + el.offsetHeight, pad = 6
    if (top - pad < this.list.scrollTop) this.list.scrollTop = top - pad
    else if (bottom + pad > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = bottom + pad - this.list.clientHeight
  }

  private renderButton() {
    const item = this.items.find((i) => i.value === this.current)
    const key = JSON.stringify([this.current, item?.label, item?.badge, !!item?.icon, this.placeholder])
    this.button.dataset.value = this.current
    this.button.dataset.railTip = `${this.label}: ${item?.label ?? this.placeholder}`
    // In a rail its tooltip names what's chosen now.
    if (this.button.dataset.tip) this.button.dataset.tip = this.button.dataset.railTip
    if (key === this.shown) return
    this.shown = key
    setMarkup(this.button, html`<span class="kit-select-ic" aria-hidden="true">${item?.icon ?? ''}</span><span class="kit-select-v">${item?.label ?? this.placeholder}</span>${item && hasBadge(item.badge) ? html`<span class="kit-select-badge">${item.badge}</span>` : ''}<span class="kit-select-chev" aria-hidden="true">${ICONS.chevron}</span>`)
  }

  private renderList() {
    const option = (item: SelectItem, i: number) => html`<div class="kit-option" role="option" id="${this.id}-o${i}" data-i="${i}" data-value="${item.value}" aria-selected="${item.value === this.current ? 'true' : 'false'}" aria-disabled="${item.disabled ? 'true' : 'false'}"><span class="kit-option-ic" aria-hidden="true">${item.icon ?? ''}</span><span class="kit-option-text"><span class="kit-option-label">${item.label}</span>${item.hint ? html`<small>${item.hint}</small>` : ''}</span>${hasBadge(item.badge) ? html`<span class="kit-option-badge">${item.badge}</span>` : ''}<span class="kit-option-check" aria-hidden="true">${ICONS.check}</span></div>`
    const blocks: { group?: string; rows: [SelectItem, number][] }[] = []
    this.items.forEach((item, i) => {
      const last = blocks[blocks.length - 1]
      if (last && last.group === item.group) last.rows.push([item, i])
      else blocks.push({ group: item.group, rows: [[item, i]] })
    })
    setMarkup(this.list, blocks.map((b, g) => b.group
      ? html`<div class="kit-listbox-set" role="group" aria-labelledby="${this.id}-g${g}"><div class="kit-listbox-group" id="${this.id}-g${g}" role="presentation">${b.group}</div>${b.rows.map(([item, i]) => option(item, i))}</div>`
      : b.rows.map(([item, i]) => option(item, i))))
  }

  /** Beside the button in a rail, else below it (above when there's more room there), inside the page's frame. */
  private place() {
    if (!this.button.isConnected) { this.close(); return }
    const frame = popoverFrame()
    const own = frame.rect(this.button)
    const beside = getComputedStyle(this.button).getPropertyValue('--kit-pop').trim() === 'beside'
    // Beside a rail, the list clears the rail's edge, level with the button.
    const rail = beside ? this.button.closest('.kit-side') : null
    const edge = rail ? frame.rect(rail) : own
    const anchor = { left: edge.left, width: edge.width, top: own.top, height: own.height }
    const l = this.list
    l.style.minWidth = beside ? '' : `${Math.round(own.width)}px`
    l.style.maxHeight = `${MAX_LIST}px`
    const at = placePopover(anchor, { width: l.offsetWidth, height: Math.min(l.scrollHeight + 2, MAX_LIST) }, frame.size(), { beside, gap: rail ? 10 : 6 })
    l.style.left = `${at.left}px`
    l.style.top = `${at.top}px`
    l.style.maxHeight = `${Math.min(MAX_LIST, at.maxHeight)}px`
    l.dataset.side = at.side
  }
}

// ---- over a native <select> -----------------------------------------------------------------------------------------

const glassOf = new WeakMap<HTMLSelectElement, GlassSelect>()

/** The select's name: its aria-label, what it's labelled by, its <label>'s own words, or its title. */
export function selectLabel(select: HTMLSelectElement): string {
  const aria = select.getAttribute('aria-label')?.trim()
  if (aria) return aria
  const by = select.getAttribute('aria-labelledby')
  if (by) {
    const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim()
    if (text) return text
  }
  const label = select.labels?.[0]
  if (label) {
    const copy = label.cloneNode(true) as HTMLElement
    copy.querySelectorAll('select, button, input, textarea, output').forEach((n) => n.remove())
    const text = copy.textContent?.replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return select.title || select.name || 'Choose'
}

/** A native select's options as the glass select's items: their group, and `data-icon`, `data-badge` and `data-hint`. */
export function selectItems(select: HTMLSelectElement): SelectItem[] {
  return [...select.options].map((o) => {
    const group = o.parentElement instanceof HTMLOptGroupElement ? o.parentElement : null
    return {
      value: o.value,
      label: o.label || o.text,
      disabled: o.disabled || !!group?.disabled,
      group: group?.label || undefined,
      icon: o.dataset.icon ? ICONS[o.dataset.icon] : undefined,
      badge: o.dataset.badge,
      hint: o.dataset.hint,
    }
  })
}

/**
 * Put a glass select over `select` (once), just before it; the select stays in the page, out of sight, holding the
 * value. Its value, options, disabled and hidden show on the glass one however the page's code changes them; choosing
 * sets its value and fires its input and change events. Returns null for a multiple or listbox-style select, or one
 * marked `data-native`.
 */
export function enhanceSelect(select: HTMLSelectElement): GlassSelect | null {
  const made = glassOf.get(select)
  if (made) return made
  if (select.multiple || select.size > 1 || select.hasAttribute('data-native')) return null
  const proto = HTMLSelectElement.prototype
  const valueDesc = Object.getOwnPropertyDescriptor(proto, 'value')!
  const glass = new GlassSelect({
    label: selectLabel(select),
    items: selectItems(select),
    value: select.value,
    className: 'kit-select-for',
    onChange: (v) => {
      valueDesc.set!.call(select, v)
      select.dispatchEvent(new Event('input', { bubbles: true }))
      select.dispatchEvent(new Event('change', { bubbles: true }))
    },
  })
  glassOf.set(select, glass)
  const sync = () => {
    glass.setItems(selectItems(select), valueDesc.get!.call(select))
    glass.button.hidden = select.hidden
    glass.disabled = select.disabled
  }
  // A value set in code shows at once: the select gets its own value and selectedIndex, wrapping the native ones.
  for (const key of ['value', 'selectedIndex'] as const) {
    const desc = Object.getOwnPropertyDescriptor(proto, key)!
    Object.defineProperty(select, key, { configurable: true, enumerable: true, get() { return desc.get!.call(this) }, set(v) { desc.set!.call(this, v); sync() } })
  }
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'label', 'selected', 'value', 'data-icon', 'data-badge', 'data-hint'] })
  select.addEventListener('change', sync)
  // Code that focuses the select focuses the button that stands for it.
  select.focus = (options?: FocusOptions) => glass.focus(options)
  select.classList.add('kit-native')
  select.tabIndex = -1
  select.setAttribute('aria-hidden', 'true')
  select.before(glass.button)
  sync()
  return glass
}

let watching = false
/**
 * Glass selects over every <select> under `root` now, and over every one the page adds later (a MutationObserver on
 * the document). A select taken out of the page takes its glass one with it.
 */
export function enhanceSelects(root: ParentNode = document) {
  root.querySelectorAll('select').forEach((s) => { enhanceSelect(s) })
  if (watching || typeof MutationObserver === 'undefined') return
  watching = true
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n instanceof HTMLSelectElement) enhanceSelect(n)
        else if (n instanceof Element && n.firstElementChild) n.querySelectorAll('select').forEach((s) => { enhanceSelect(s) })
      }
      for (const n of r.removedNodes) {
        const glass = n instanceof HTMLSelectElement ? glassOf.get(n) : undefined
        if (glass && !n.isConnected) { glass.close(); glass.button.remove() }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true })
  // A form reset puts its selects back without events.
  document.addEventListener('reset', (e) => setTimeout(() => {
    (e.target as HTMLFormElement).querySelectorAll?.('select').forEach((s) => s.dispatchEvent(new Event('change')))
  }), true)
}
