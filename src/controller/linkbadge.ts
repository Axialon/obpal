/**
 * The connection badge in the controller's top bar, and its sheet. It says only what the link itself shows: that it is
 * encrypted end to end (DTLS between this phone and the screen, so nothing between them, the room service or a relay,
 * can read or change it), how this phone knew the screen was the right one (the QR code, the code typed, or a
 * remembered pairing), the path (direct, or relayed) and the round trip. The badge uses the seal as its connected
 * signal; a tap opens the full comparison and a line on each fact. Built from elements, never parsed markup.
 */
import type { ConnectionSeal, LinkStats, VerifiedBy } from '@obpal/core'
import { destroySeal, sealElement, landSeal, SEAL_STYLE, tiltSeal, DotLoader, DOT_LOADER_STYLE } from '@obpal/host'
import { showShares } from '../ui/shares'
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
  private stopMoment = () => {}
  private closeShares = () => {}
  private first: HTMLElement | null = null
  private firstObserver: MutationObserver | null = null
  private seal: ConnectionSeal | null = null
  private compact: HTMLElement | null = null
  private momentUntil = 0
  private loader = new DotLoader({ size: 34, label: 'Reconnecting to the screen' })
  private slot: HTMLElement | null = null
  private readonly layoutObserver: MutationObserver

  constructor(private readonly disconnect: () => void = () => {}) {
    this.ms = h('span', { class: 'lb-ms' })
    this.el = h('button', { class: 'link-badge glass', type: 'button', 'data-state': 'down', 'aria-haspopup': 'dialog', 'aria-label': 'Connection' },
      LOCK(), this.loader.el, this.ms)
    this.loader.finish()
    this.el.addEventListener('click', () => this.open())
    const style = document.createElement('style')
    style.textContent = SEAL_STYLE + DOT_LOADER_STYLE + `
.bar .link-badge,.gp .link-badge{width:126px;padding:0 8px;justify-content:center;gap:6px}
.bar .link-badge{width:clamp(78px,calc(100cqw - 188px),126px)}
.bar .link-badge .connection-seal{width:100%;min-width:0;grid-template-columns:minmax(0,1fr)}
.bar .link-badge .connection-seal canvas{width:100%}
.bar .host-name{min-width:44px}
.link-badge.has-seal>.ic,.link-badge.has-seal>.lb-ms,.link-badge.has-seal>.dot-loader{display:none}
.link-badge .dot-loader>i{position:static;box-shadow:none;background:currentColor;width:16%;height:auto}
.link-badge .connection-seal{--seal-ink:var(--bb-ink,var(--ink));background:var(--bb-sheet,var(--sheet))}
.link-badge .lb-ms{display:none}
.bar .host-t{min-width:0}
.gp .link-badge{display:inline-flex;justify-content:center;gap:6px;padding:0 8px}
.gp .link-badge .lb-ms{display:none}
.trust-first .seal-compact{display:none}
.trust-first .trust-compare{min-width:0}
.trust-first .trust-compare>span{flex:0 1 auto;min-width:0;white-space:normal;text-align:center}
.gate-card .trust-first .seal-compact{display:inline-grid}
.gate-card .trust-first .trust-compare{display:grid;grid-column:1/-1;justify-items:center;gap:6px}
`
    document.head.append(style)
    this.layoutObserver = new MutationObserver(() => this.placeStatus())
    this.layoutObserver.observe(document.getElementById('app') ?? document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    addEventListener('pagehide', () => { this.loader.destroy(); this.layoutObserver.disconnect(); this.stopMoment(); this.closeShares(); this.clearFirst(); this.clearSeal(); if (this.compact) destroySeal(this.compact) }, { once: true })
  }

  /** Take the top bar's slot for it. */
  mount(slot: HTMLElement) {
    this.slot = slot
    slot.style.display = 'contents'
    slot.replaceChildren(this.el)
    this.placeStatus()
    this.placeFirst()
    this.render()
  }

  /** What the link says now (every couple of seconds while it's up). */
  update(s: LinkStats) {
    this.stats = s
    if (s.seal && s.seal.join('-') !== this.seal?.join('-')) this.seal = s.seal
    this.render()
  }

  /** The link isn't up (reconnecting, waiting for the screen): the badge vouches for nothing until it is again. */
  down(state = 'down') {
    this.stats = null
    this.seal = null
    this.stopMoment()
    this.clearFirst()
    this.render()
    this.el.dataset.state = state
    if (state === 'connecting' || state === 'reconnecting') this.loader.start()
    else this.loader.finish()
  }

  /** The UI starts only after the phone verified the fresh session proof. */
  reveal(s: { seal: ConnectionSeal; delayMs: number; source?: string }) {
    this.seal = s.seal
    this.stopMoment()
    this.momentUntil = performance.now() + s.delayMs + 1200
    this.clearFirst()
    const domain = h('span', { class: 'trust-domain', 'aria-label': `Encrypted connection; ${location.hostname}` }, LOCK(), location.hostname)
    const words = h('span', {}, 'Connected to the screen showing this seal')
    const compare = h('button', { type: 'button', class: 'trust-compare', 'aria-label': 'Compare connection seal' }, sealElement(s.seal, true), words)
    compare.onclick = () => this.open()
    const shares = h('button', { type: 'button', class: 'trust-shares' }, 'What this shares')
    shares.onclick = () => { this.closeShares(); this.closeShares = showShares(this.disconnect) }
    const dismiss = h('button', { type: 'button', class: 'trust-dismiss', 'aria-label': 'Dismiss connection notice' }, CLOSE())
    dismiss.onclick = () => this.clearFirst()
    this.first = h('div', { class: 'trust-first glass', role: 'status' }, domain, compare, shares, dismiss)
    this.firstObserver = new MutationObserver(() => this.placeFirst())
    this.firstObserver.observe(document.getElementById('app') ?? document.body, { childList: true, subtree: true })
    this.placeFirst()
    this.render()
    if (this.compact) this.stopMoment = landSeal(this.compact, s.delayMs, s.source)
  }

  tilt(x: number, y: number) {
    if (this.compact && performance.now() >= this.momentUntil) tiltSeal(this.compact, x, y)
    this.sheet?.body.querySelectorAll<HTMLElement>('.connection-seal').forEach(row => tiltSeal(row, x, y))
  }
  private placeFirst() {
    if (!this.first) return
    const bar = this.el.closest('.bar')
    const gate = document.querySelector('.gate-card')
    if (bar?.isConnected) {
      if (this.first.previousElementSibling !== bar) bar.after(this.first)
      this.firstObserver?.disconnect()
    } else if (gate) {
      if (this.first.parentElement !== gate) gate.prepend(this.first)
      this.firstObserver?.disconnect()
    }
  }
  private clearFirst() {
    this.firstObserver?.disconnect(); this.firstObserver = null
    this.first?.querySelectorAll<HTMLElement>('.connection-seal').forEach(destroySeal)
    this.first?.remove(); this.first = null
  }
  /** Gamepad uses its own chrome; keep the same connection status beside its motion controls. */
  private placeStatus() {
    const target = document.querySelector('.surface.gp-on .gp-motion') ?? this.slot
    if (target?.isConnected && this.el.parentElement !== target) target.append(this.el)
  }
  private clearSeal() { this.sheet?.body.querySelectorAll<HTMLElement>('.connection-seal').forEach(destroySeal) }

  private render() {
    const s = this.stats
    const up = !!this.seal || (!!s && s.link?.secure !== false)
    this.el.dataset.state = up ? 'up' : 'down'
    this.el.dataset.path = s?.path === 'relay' ? 'relay' : 'direct'
    this.ms.textContent = up && s?.rttMs != null ? `${s.rttMs} ms` : ''
    const seal = this.seal ?? s?.seal
    if (this.compact?.dataset.seal !== seal?.join('-')) {
      if (this.compact) { destroySeal(this.compact); this.compact.remove() }
      this.compact = seal ? sealElement(seal, true) : null
      if (this.compact) this.el.append(this.compact)
    }
    this.el.classList.toggle('has-seal', !!this.compact)
    if (this.compact) this.loader.finish()
    this.el.setAttribute('aria-label', up
      ? `Encrypted${s?.verified ? ', verified' : ''}${s ? `, ${pathWords(s)[0].toLowerCase()}` : ''}${s?.rttMs != null ? `, ${s.rttMs} ms round trip` : ''}. ${this.compact?.getAttribute('aria-label') ?? 'Connection details'}. Compare both screens`
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
    const close = () => { exits(); this.clearSeal(); this.sheet = null; wrap.classList.add('out'); setTimeout(() => wrap.remove(), 200) }
    x.addEventListener('click', close)
    this.sheet = { body, close }
    this.fill(body)
    document.body.appendChild(wrap)
    exits = sheetExits(wrap, close)
  }

  private fill(body: HTMLElement) {
    const s = this.stats
    const seal = this.seal ?? s?.seal
    const previous = body.querySelector<HTMLElement>('.connection-seal')
    const same = !!seal && previous?.dataset.seal === seal.join('-')
    if (!same) this.clearSeal()
    const row = (ic: SVGSVGElement, title: string, detail: string, tone = '') =>
      h('div', { class: 'link-row', ...(tone ? { 'data-tone': tone } : {}) }, h('span', { class: 'lr-ic' }, ic), h('span', {}, h('b', {}, title), h('small', {}, detail)))
    if (seal && !s) {
      const shares = h('button', { type: 'button', class: 'btn' }, 'What this shares')
      shares.onclick = () => { this.sheet?.close(); this.closeShares(); this.closeShares = showShares(this.disconnect) }
      body.replaceChildren(h('div', { class: 'link-seal' }, h('b', {}, 'Connection seal'), same ? previous! : sealElement(seal), h('small', {}, 'Check both screens show the same seal')), row(PATH(), 'Finding the path', 'Connection statistics appear when the link reports them.'), shares)
      return
    }
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
    if (seal) rows.unshift(h('div', { class: 'link-seal' }, h('b', {}, 'Connection seal'), same ? previous! : sealElement(seal), h('small', {}, 'Check both screens show the same seal')))
    const shares = h('button', { type: 'button', class: 'btn' }, 'What this shares')
    shares.onclick = () => { this.sheet?.close(); this.closeShares(); this.closeShares = showShares(this.disconnect) }
    body.replaceChildren(...rows, shares)
  }
}
