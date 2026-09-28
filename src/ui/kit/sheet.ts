/**
 * The bottom sheet: a frosted panel that rises from the bottom edge over a scrim, with a grabber and a titled header
 * to drag it back down by, a body that scrolls on its own, and an optional footer for its actions. It's a modal dialog
 * (./modal.ts): the page behind is inert, Escape or the scrim closes it, and focus returns to what opened it.
 */
import { ModalLayer } from './modal'
import { ICONS } from '../icons'
import { html, setMarkup } from '../markup'
import '../../styles/kit.css'

export interface SheetOptions {
  title: string
  /** It closed, however. */
  onClose?: () => void
}

export class Sheet {
  readonly el: HTMLElement
  readonly body: HTMLDivElement
  readonly footer: HTMLDivElement
  private readonly layer: ModalLayer

  constructor(opts: SheetOptions) {
    const el = this.el = document.createElement('section')
    el.className = 'kit-sheet'
    el.dataset.open = 'false'
    setMarkup(el, html`<div class="kit-sheet-head"><span class="kit-grabber" aria-hidden="true"></span><h2 class="kit-sheet-title"></h2><button type="button" class="kit-icon-btn kit-sheet-x" aria-label="Close">${ICONS.close}</button></div><div class="kit-sheet-body"></div><div class="kit-sheet-foot"></div>`)
    el.querySelector('h2')!.textContent = opts.title
    this.body = el.querySelector('.kit-sheet-body')!
    this.footer = el.querySelector('.kit-sheet-foot')!
    const head = el.querySelector<HTMLElement>('.kit-sheet-head')!
    this.layer = new ModalLayer(el, { edge: 'bottom', label: opts.title, handle: head, onClose: opts.onClose })
    el.querySelector('.kit-sheet-x')!.addEventListener('click', () => this.close())
    document.body.append(el)
  }

  get isOpen() { return this.layer.isOpen }
  open(opener?: HTMLElement | null) { this.layer.open(opener) }
  close() { this.layer.close() }
}
