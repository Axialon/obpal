/**
 * The collapsible sidebar and its icon rail. On a wide screen it's docked beside the content, expanded or folded to a
 * rail of icons, and remembers which. On a tablet it stays a rail, and expanding it slides the whole sidebar over the
 * content as a drawer. On a phone (narrow, or held sideways and short) it's out of sight until it opens as a bottom
 * sheet. The element carries data-mode (docked, drawer, sheet), data-state (expanded, collapsed) and, as a drawer or
 * sheet, data-open; styles/kit.css lays each out. Its toggles get aria-expanded and aria-controls, and their names
 * from data-label-open and data-label-closed. In the rail, anything with data-rail-tip shows that as a tooltip.
 */
import { ModalLayer } from './modal'
import '../../styles/kit.css'

export type SidebarMode = 'docked' | 'drawer' | 'sheet'
export type SidebarState = 'expanded' | 'collapsed'

/**
 * The presentation a viewport gets: a sheet on a phone (`narrow` wide or less, or `short` high or less, as a phone held
 * sideways is), docked from `wide` up, a drawer between.
 */
export function sidebarMode(width: number, height: number, { wide = 1200, narrow = 700, short = 500 } = {}): SidebarMode {
  if (width <= narrow || height <= short) return 'sheet'
  return width >= wide ? 'docked' : 'drawer'
}

type Store = Pick<Storage, 'getItem' | 'setItem'>
const local = (): Store | null => { try { return localStorage } catch { return null } }

/** The docked state remembered under `key`: collapsed, or expanded (also for nothing stored, or storage that throws). */
export function readSidebar(key: string, store: Store | null = local()): SidebarState {
  try { return store?.getItem(key) === 'collapsed' ? 'collapsed' : 'expanded' } catch { return 'expanded' }
}

/** Remember the docked state; storage that's missing or throws (a private window) just doesn't remember. */
export function writeSidebar(key: string, state: SidebarState, store: Store | null = local()) {
  try { store?.setItem(key, state) } catch { /* private mode */ }
}

export interface SidebarOptions {
  /** Where the docked state is remembered. */
  key: string
  /** Its name as a drawer or sheet (a dialog then). */
  label: string
  /** Buttons that fold and unfold it (docked), or open and close it (drawer, sheet). */
  toggles?: HTMLElement[]
  /** What a finger drags to dismiss the sheet (its grabber and header), and the drawer. */
  sheetHandle?: HTMLElement | null
  drawerHandle?: HTMLElement | null
  /** The presentation for this viewport: sidebarMode() of the window's size unless given. */
  modeFor?: () => SidebarMode
  /** Its mode, or whether it's expanded (or open), changed. */
  onChange?: (mode: SidebarMode, expanded: boolean) => void
}

export class Sidebar {
  mode: SidebarMode
  private docked: SidebarState
  private readonly drawer: ModalLayer
  private readonly sheet: ModalLayer
  private raf = 0

  constructor(readonly el: HTMLElement, private opts: SidebarOptions) {
    this.docked = readSidebar(opts.key)
    this.mode = this.modeFor()
    const onClose = () => this.apply()
    this.drawer = new ModalLayer(el, { edge: 'left', label: opts.label, handle: opts.drawerHandle, onClose })
    this.sheet = new ModalLayer(el, { edge: 'bottom', label: opts.label, handle: opts.sheetHandle, onClose })
    for (const t of opts.toggles ?? []) {
      if (el.id) t.setAttribute('aria-controls', el.id)
      t.addEventListener('click', () => this.toggle(t))
    }
    addEventListener('resize', () => {
      if (this.raf) return
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.refresh() })
    })
    this.apply(false)
    // Only the changes a person makes animate, not the first layout.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('kit-side-ready')))
  }

  private modeFor() { return this.opts.modeFor?.() ?? sidebarMode(innerWidth, innerHeight) }
  private get layer() { return this.mode === 'sheet' ? this.sheet : this.drawer }

  /** Docked: expanded rather than a rail. Drawer or sheet: open. */
  get expanded(): boolean {
    return this.mode === 'docked' ? this.docked === 'expanded' : this.layer.isOpen
  }

  toggle(opener?: HTMLElement) { if (this.expanded) this.collapse(); else this.expand(opener) }

  expand(opener?: HTMLElement) {
    if (this.mode === 'docked') { this.docked = 'expanded'; writeSidebar(this.opts.key, 'expanded'); this.apply(); return }
    this.layer.open(opener ?? (document.activeElement as HTMLElement | null))
    this.apply()
  }

  collapse() {
    if (this.mode === 'docked') { this.docked = 'collapsed'; writeSidebar(this.opts.key, 'collapsed'); this.apply(); return }
    this.layer.close()
  }

  /** Take the presentation the viewport now calls for (on resize); an open drawer or sheet closes on the way. */
  refresh() {
    const mode = this.modeFor()
    if (mode === this.mode) return
    this.drawer.close({ restore: false })
    this.sheet.close({ restore: false })
    this.mode = mode
    this.apply()
  }

  private apply(notify = true) {
    const el = this.el
    const expanded = this.expanded
    el.dataset.mode = this.mode
    el.dataset.state = expanded ? 'expanded' : 'collapsed'
    if (this.mode === 'docked') delete el.dataset.open
    else el.dataset.open = String(expanded)
    for (const t of this.opts.toggles ?? []) {
      t.setAttribute('aria-expanded', String(expanded))
      const name = t.dataset[expanded ? 'labelOpen' : 'labelClosed']
      if (name) t.setAttribute('aria-label', name)
    }
    // The rail names its icons in tooltips; expanded, the names are there to read.
    const rail = !expanded && this.mode !== 'sheet'
    for (const n of el.querySelectorAll<HTMLElement>('[data-rail-tip]')) {
      if (rail) { n.dataset.tip = n.dataset.railTip!; n.dataset.tipSide = 'right' }
      else { delete n.dataset.tip; delete n.dataset.tipSide }
    }
    if (notify) this.opts.onChange?.(this.mode, expanded)
  }
}
