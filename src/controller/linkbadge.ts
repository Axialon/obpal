/**
 * The connection badge in the controller's top bar, and its sheet. It says only what the link itself shows: that it is
 * encrypted end to end (DTLS between this phone and the screen, so nothing between them, the room service or a relay,
 * can read or change it), how this phone knew the screen was the right one (the QR code, the code typed, or a
 * remembered pairing), the path (direct, or relayed) and the round trip. The badge is a lock, the path's colour and the
 * round trip; a tap opens a line on each. Built from elements, never parsed markup.
 */
import type { LinkStats, VerifiedBy } from '@obpal/core'
import { sheetExits } from './sheet'

const NS = 'http://www.w3.org/2000/svg'

/** A stroke icon in the controller's style (base.css .ic), from path data and shapes. */
function icon(...parts: [tag: string, attrs: Record<string, string>][]): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'ic')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    svg.appendChild(el)
  }
  return svg
}
const LOCK = () => icon(['rect', { x: '5.5', y: '10.5', width: '13', height: '9.5', rx: '2.6' }], ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' }])
const SHIELD = () => icon(['path', { d: 'M12 3.5 5.5 6v5.2c0 4 2.7 7.4 6.5 8.8 3.8-1.4 6.5-4.8 6.5-8.8V6L12 3.5Z' }], ['path', { d: 'm9 12 2.2 2.2L15.5 10' }])
const PATH = () => icon(['circle', { cx: '6', cy: '17.5', r: '2.2' }], ['circle', { cx: '18', cy: '6.5', r: '2.2' }], ['path', { d: 'M8 16.2c3-1 2.3-4.4 5-5.6 1.4-.6 2.6-1.2 3.2-2.4' }])
const CLOCK = () => icon(['circle', { cx: '12', cy: '13', r: '7' }], ['path', { d: 'M12 9.5V13l2.3 1.8M10 3.5h4' }])
const CLOSE = () => icon(['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }])

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  el.append(...kids)
  return el
}

const VERIFIED: Record<VerifiedBy, [title: string, detail: string]> = {
  qr: ['Verified by the QR code', 'The code pinned this screen’s key, and this phone proved it had the code.'],
  code: ['Verified by the code you typed', 'Both ends proved they had it (its secret part never left either device), tied to this connection’s keys.'],
  lan: ['Verified by your pairing', 'Both ends checked the keys they kept when they first paired.'],
}

/** The path in a word, and a line on it. */
function pathWords(s: LinkStats): [title: string, detail: string] {
  const via = s.link?.relayProtocol ? ` over ${s.link.relayProtocol.toUpperCase()}` : ''
  switch (s.link?.path ?? (s.path === 'relay' ? 'relay' : s.path === 'direct' ? 'direct' : 'unknown')) {
    case 'lan': return ['Direct', 'Straight to the screen, on your own network.']
    case 'nat': return ['Direct', 'Straight to the screen, over the internet.']
    case 'direct': return ['Direct', 'Straight to the screen, peer to peer.']
    case 'relay': return ['Relayed', `Through a TURN relay${via}, which ICE takes only while no direct path works. It passes the data on without being able to read it.`]
    default: return ['Finding the path', 'The connection hasn’t said which way it goes yet.']
  }
}

export class LinkBadge {
  readonly el: HTMLButtonElement
  private readonly ms: HTMLElement
  private stats: LinkStats | null = null
  private sheet: { body: HTMLElement; close: () => void } | null = null

  constructor() {
    this.ms = h('span', { class: 'lb-ms' })
    this.el = h('button', { class: 'link-badge glass', type: 'button', 'data-state': 'down', 'aria-haspopup': 'dialog', 'aria-label': 'Connection' },
      LOCK(), h('i', { 'aria-hidden': 'true' }), this.ms)
    this.el.addEventListener('click', () => this.open())
  }

  /** Take the top bar's slot for it. */
  mount(slot: HTMLElement) {
    slot.replaceWith(this.el)
    this.render()
  }

  /** What the link says now (every couple of seconds while it's up). */
  update(s: LinkStats) {
    this.stats = s
    this.render()
  }

  /** The link isn't up (reconnecting, waiting for the screen): the badge vouches for nothing until it is again. */
  down() {
    this.stats = null
    this.render()
  }

  private render() {
    const s = this.stats
    const up = !!s && s.link?.secure !== false
    this.el.dataset.state = up ? 'up' : 'down'
    this.el.dataset.path = s?.path === 'relay' ? 'relay' : 'direct'
    this.ms.textContent = up && s!.rttMs != null ? `${s!.rttMs} ms` : ''
    this.el.setAttribute('aria-label', up
      ? `Encrypted${s!.verified ? ', verified' : ''}, ${pathWords(s!)[0].toLowerCase()}${s!.rttMs != null ? `, ${s!.rttMs} ms round trip` : ''}. Connection details`
      : 'Not connected. Connection details')
    if (this.sheet) this.fill(this.sheet.body)
  }

  /** The details: a line each on encryption, verification, the path and the round trip. */
  private open() {
    if (this.sheet) return
    const body = h('div', { class: 'link-rows' })
    const x = h('button', { class: 'icon-btn glass sheet-x', type: 'button', 'aria-label': 'Close' }, CLOSE())
    const card = h('div', { class: 'sheet link-sheet glass', role: 'dialog', 'aria-label': 'Connection' },
      h('div', { class: 'sheet-head' }, h('div', { class: 'grip', 'aria-hidden': 'true' }), x),
      h('h2', {}, 'Connection'), body,
      h('p', { class: 'link-foot' }, 'The room service only passes the handshake along. It never sees the code’s secret, or anything you send.'))
    const wrap = h('div', { class: 'sheet-wrap' }, card)
    let exits = () => {}
    const close = () => { exits(); this.sheet = null; wrap.classList.add('out'); setTimeout(() => wrap.remove(), 200) }
    x.addEventListener('click', close)
    this.sheet = { body, close }
    this.fill(body)
    document.body.appendChild(wrap)
    exits = sheetExits(wrap, close)
  }

  private fill(body: HTMLElement) {
    const s = this.stats
    const row = (ic: SVGSVGElement, title: string, detail: string, tone = '') =>
      h('div', { class: 'link-row', ...(tone ? { 'data-tone': tone } : {}) }, h('span', { class: 'lr-ic' }, ic), h('span', {}, h('b', {}, title), h('small', {}, detail)))
    if (!s || s.link?.secure === false) {
      body.replaceChildren(row(PATH(), 'Not connected', 'Once the phone and the screen are linked again, this says how.', 'off'))
      return
    }
    const cipher = [s.link?.dtls, s.link?.cipher].filter(Boolean).join(' · ')
    const [pathTitle, pathDetail] = pathWords(s)
    const rows = [
      row(LOCK(), 'Encrypted end to end', `Only this phone and the screen hold the keys.${cipher ? ` ${cipher}.` : ''}`),
      ...(s.verified ? [row(SHIELD(), ...VERIFIED[s.verified])] : []),
      row(PATH(), pathTitle, pathDetail, s.path === 'relay' ? 'warn' : ''),
      ...(s.rttMs != null ? [row(CLOCK(), `Round trip ${s.rttMs} ms`, s.link?.rttMs != null ? `The network’s own share: ${s.link.rttMs} ms.` : 'From this phone to the screen and back.')] : []),
    ]
    body.replaceChildren(...rows)
  }
}
