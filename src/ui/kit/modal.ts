/**
 * A layer over the page: the drawer and the bottom sheet. While one is open the rest of the page is inert (no pointer,
 * no focus, hidden from assistive tech) behind a scrim, Tab stays inside it, Escape or the scrim closes it, and focus
 * goes back to what opened it. On touch, dragging it back toward its edge (its handle, or the sheet from its top)
 * dismisses it; a short drag springs back. The slide itself is CSS (styles/kit.css), keyed on data-open.
 */
import '../../styles/kit.css'
import { railAxis, railPull } from '../rail'

export type Edge = 'left' | 'bottom'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Whether a drag of `moved` px toward the edge, at `speed` px/ms, dismisses a layer `size` px deep: past a third of
 * it, or a flick. A drag away from the edge never does.
 */
export function dismisses(moved: number, size: number, speed: number): boolean {
  if (moved <= 0) return false
  return moved > size / 3 || (speed > 0.5 && moved > 24)
}

/** The element's ancestors' siblings, up to the body: what has to be inert for it to be alone on the page. */
function others(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    const parent: HTMLElement | null = node.parentElement
    if (!parent) break
    for (const sib of [...parent.children] as Element[]) {
      if (sib === node || !(sib instanceof HTMLElement)) continue
      // Popovers, tooltips and the scrim stay live: they belong to the layer.
      if (sib.matches('[data-kit-popover], .kit-scrim, .tip, .bb-tip, script, style, link')) continue
      out.push(sib)
    }
  }
  return out
}

export interface ModalOptions {
  edge: Edge
  /** Its name while it's a dialog. */
  label: string
  /** Where a drag starts (the sheet's grabber and header); none: no drag to dismiss. */
  handle?: HTMLElement | null
  /** It closed (Escape, the scrim, a drag, or code). */
  onClose?: () => void
}

export class ModalLayer {
  private scrim: HTMLDivElement | null = null
  private made: HTMLElement[] = []
  private opener: HTMLElement | null = null
  private drag: { id: number; x: number; y: number; start: number; at: number; t: number; v: number; axis: 'x' | 'y' | null } | null = null
  private opened = false
  private readonly keys = (e: KeyboardEvent) => this.key(e)

  constructor(readonly el: HTMLElement, private opts: ModalOptions) {
    const h = opts.handle
    if (h) {
      h.addEventListener('pointerdown', (e) => this.dragStart(e))
      h.addEventListener('pointermove', (e) => this.dragMove(e))
      h.addEventListener('pointerup', (e) => this.dragEnd(e))
      h.addEventListener('pointercancel', (e) => this.dragEnd(e, true))
      h.addEventListener('lostpointercapture', (e) => this.dragEnd(e, true))
    }
  }

  /** Its own: two layers (a drawer and a sheet) can share one element, one open at a time. */
  get isOpen() { return this.opened }

  open(opener: HTMLElement | null = document.activeElement as HTMLElement | null) {
    if (this.opened) return
    this.opened = true
    this.opener = opener
    const el = this.el
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    el.setAttribute('aria-label', this.opts.label)
    const scrim = this.scrim = document.createElement('div')
    scrim.className = `kit-scrim kit-scrim-${this.opts.edge}`
    scrim.addEventListener('click', () => this.close())
    document.body.append(scrim)
    this.made = others(el).filter((n) => !n.inert)
    for (const n of this.made) n.inert = true
    document.documentElement.classList.add('kit-locked')
    el.dataset.open = 'true'
    requestAnimationFrame(() => scrim.dataset.open = 'true')
    // The keys work wherever focus is while it's open; a control inside that handles Escape itself keeps it.
    document.addEventListener('keydown', this.keys)
    const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE)
    if (!first && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    this.focusIn(first ?? el)
  }

  /** Focus `target`, again on the next frames if it can't take it yet (still becoming visible as the layer opens). */
  private focusIn(target: HTMLElement, tries = 3) {
    target.focus({ preventScroll: true })
    if (this.opened && tries > 0 && !this.el.contains(document.activeElement)) requestAnimationFrame(() => { if (this.opened) this.focusIn(target, tries - 1) })
  }

  /** Close it; focus goes back to what opened it unless `restore` is false. */
  close({ restore = true } = {}) {
    if (!this.opened) return
    this.opened = false
    const el = this.el
    el.dataset.open = 'false'
    this.drag = null
    el.classList.remove('kit-dragging')
    el.style.transform = ''
    el.removeAttribute('role')
    el.removeAttribute('aria-modal')
    el.removeAttribute('aria-label')
    document.removeEventListener('keydown', this.keys)
    for (const n of this.made) n.inert = false
    this.made = []
    document.documentElement.classList.remove('kit-locked')
    const scrim = this.scrim
    this.scrim = null
    if (scrim) {
      scrim.dataset.open = 'false'
      const gone = () => scrim.remove()
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) gone()
      else setTimeout(gone, 260)
    }
    if (restore && this.opener?.isConnected) this.opener.focus({ preventScroll: true })
    this.opener = null
    this.opts.onClose?.()
  }

  private key(e: KeyboardEvent) {
    if (e.defaultPrevented) return
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return }
    if (e.key !== 'Tab') return
    // Tab goes round inside the layer.
    const list = [...this.el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.getClientRects().length && !n.closest('[inert]') && getComputedStyle(n).visibility !== 'hidden')
    if (!list.length) { e.preventDefault(); return }
    const first = list[0], last = list[list.length - 1]
    if (!this.el.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus() }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  // ---- drag to dismiss -----------------------------------------------------------------------------------------------

  private along(e: PointerEvent) { return this.opts.edge === 'bottom' ? e.clientY : -e.clientX }

  private dragStart(e: PointerEvent) {
    if (!this.isOpen || e.pointerType === 'mouse' || (e.target as Element).closest('button, a, input, [role="slider"]')) return
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: this.along(e), at: this.along(e), t: e.timeStamp, v: 0, axis: null }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  private dragMove(e: PointerEvent) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    d.axis ??= railAxis(e.clientX - d.x, e.clientY - d.y)
    if (d.axis !== (this.opts.edge === 'bottom' ? 'y' : 'x')) return
    this.el.classList.add('kit-dragging')
    const now = this.along(e)
    const dt = Math.max(1, e.timeStamp - d.t)
    d.v = (now - d.at) / dt
    d.at = now
    d.t = e.timeStamp
    const size = this.opts.edge === 'bottom' ? this.el.offsetHeight : this.el.offsetWidth
    const moved = railPull(now - d.start, size)
    this.el.style.transform = this.opts.edge === 'bottom' ? `translateY(${moved}px)` : `translateX(${-moved}px)`
  }

  private dragEnd(e: PointerEvent, cancelled = false) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    this.drag = null
    this.el.classList.remove('kit-dragging')
    const size = this.opts.edge === 'bottom' ? this.el.offsetHeight : this.el.offsetWidth
    if (!cancelled && d.axis === (this.opts.edge === 'bottom' ? 'y' : 'x') && dismisses(d.at - d.start, size, d.v)) this.close()
    else this.el.style.transform = ''
  }
}
