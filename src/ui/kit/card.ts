/**
 * Widget cards: a dark frosted card with a numbered small-caps header ("01 · Arm status"), an optional status or
 * action at the header's end, and a body for readouts, gauges and controls. The number is the card's place on its
 * panel, two digits.
 */
import '../../styles/kit.css'

let seq = 0

/** A card's number as its header shows it: two digits at least. */
export const cardNumber = (n: number) => String(Math.max(0, Math.round(n))).padStart(2, '0')

export interface CardOptions {
  title: string
  /** Its place on the panel; none, no number. */
  n?: number
  /** At the header's end: a status dot, a count, a button. */
  aside?: Node | null
  /** The card's contents. */
  body?: Node | Node[] | null
  className?: string
}

/** The header alone: number, title, and what sits at its end. */
export function cardHeader({ title, n, aside }: Pick<CardOptions, 'title' | 'n' | 'aside'>): HTMLElement {
  const head = document.createElement('header')
  head.className = 'kit-card-head'
  if (n !== undefined) {
    const num = document.createElement('span')
    num.className = 'kit-card-n'
    num.textContent = cardNumber(n)
    head.append(num)
  }
  const h = document.createElement('h3')
  h.className = 'kit-card-title'
  h.textContent = title
  head.append(h)
  if (aside) {
    const end = document.createElement('span')
    end.className = 'kit-card-aside'
    end.append(aside)
    head.append(end)
  }
  return head
}

/** A card: its header, then its body; the card is labelled by its title. */
export function widgetCard(opts: CardOptions): HTMLElement {
  const card = document.createElement('section')
  card.className = ['kit-card', opts.className].filter(Boolean).join(' ')
  const head = cardHeader(opts)
  const title = head.querySelector('h3')!
  title.id = `kit-card-${++seq}`
  card.setAttribute('aria-labelledby', title.id)
  const body = document.createElement('div')
  body.className = 'kit-card-body'
  if (opts.body) body.append(...(Array.isArray(opts.body) ? opts.body : [opts.body]))
  card.append(head, body)
  return card
}
