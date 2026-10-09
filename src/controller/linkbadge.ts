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
import { dismiss as dismissNotice, notify } from '../ui/kit/notice'
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
const INFO = () => icon(['circle', { cx: '12', cy: '12', r: '8.5' }], ['path', { d: 'M12 11v5M12 8h.01' }])
/** How long the first connection notice shows in full before it quiets to one slim row. */
export const TRUST_QUIET_MS = 4000

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

/** The id of the trust notice among the notices (src/ui/kit/notice.ts). */
const TRUST = 'trust'
/**
 * The trust notice stays this long after the seal's moment ends (SETTLE_FIRST_MS the first time this session that a screen
 * is connected to), then folds into the badge in the bar, which already carries the seal and opens its comparison. A touch
 * on it holds it still. Left in the gate card (before the controls are up) it stays until they are.
 */
const SETTLE_MS = 8000
const SETTLE_FIRST_MS = 12000
const SEEN = 'obpal.trust.seen.'

export class LinkBadge {
  readonly el: HTMLButtonElement
  private readonly ms: HTMLElement
  private stats: LinkStats | null = null
  private sheet: { body: HTMLElement; close: (handOver?: boolean) => void } | null = null
  private stopMoment = () => {}
  private closeShares = () => {}
  private first: HTMLElement | null = null
  private quietTimer: ReturnType<typeof setTimeout> | undefined
  private firstDismiss: HTMLButtonElement | null = null
  /** The notice is up among the notices (over the controls' work area), not in the gate card. */
  private railed = false
  private firstMs = SETTLE_MS
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
.bar .link-badge,.gp .link-badge{padding:0 8px;justify-content:center;gap:6px}
.bar .link-badge .connection-seal{width:100%;min-width:0;grid-template-columns:minmax(0,1fr)}
.bar .link-badge .connection-seal canvas{width:100%}
.bar .host-name{min-width:44px}
.link-badge.has-seal>.ic,.link-badge.has-seal>.lb-ms,.link-badge.has-seal>.dot-loader{display:none}
.link-badge .dot-loader>i{position:static;box-shadow:none;background:currentColor;width:16%;height:auto}
.link-badge .connection-seal{--seal-ink:var(--bb-ink,var(--ink));background:var(--bb-sheet,var(--sheet))}
.link-badge .lb-ms{display:none}
.bar .host-t{min-width:0}
.gp .link-badge{width:126px;display:inline-flex;justify-content:center;gap:6px;padding:0 8px}
.gp .link-badge .lb-ms{display:none}
.trust-first .seal-compact{display:none}
.trust-first .trust-compare{min-width:0}
.trust-first .trust-compare>span{flex:0 1 auto;min-width:0;white-space:normal;text-align:center}
.gate-card .trust-first .seal-compact{display:inline-grid}
.gate-card .trust-first .trust-compare{display:grid;grid-column:1/-1;justify-items:center;gap:6px}
.trust-shares .ic{display:none}
.nt-item .trust-first{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;column-gap:4px;align-items:center;width:100%;min-width:0;padding:0;font-size:12px;line-height:1.3}
.nt-item .trust-domain{grid-column:1;grid-row:1;min-height:0;padding:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.nt-item .trust-compare{grid-column:1;grid-row:2;position:relative;min-height:0;padding:0 0 2px;color:var(--secondary);font-size:11.5px;font-weight:600;line-height:1.3}
.nt-item .trust-compare>span{text-align:left}
.nt-item .trust-shares{display:none}
.nt-item .trust-dismiss{position:relative;right:auto;top:auto}
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
    // Its quiet row's short label (the sentence, announced as the notice appeared, stays in it, folded).
    const short = h('span', { class: 'trust-short', 'aria-hidden': 'true' }, 'Compare seal')
    const compare = h('button', { type: 'button', class: 'trust-compare', 'aria-label': 'Compare connection seal' }, sealElement(s.seal, true), words, short)
    compare.onclick = () => this.open()
    const shares = h('button', { type: 'button', class: 'trust-shares' }, INFO(), h('span', { class: 'trust-lbl' }, 'What this shares'))
    shares.onclick = () => { this.closeShares(); this.closeShares = showShares(this.disconnect) }
    this.firstDismiss = h('button', { type: 'button', class: 'trust-dismiss', 'aria-label': 'Dismiss connection notice' }, CLOSE())
    this.firstDismiss.onclick = () => this.clearFirst()
    this.first = h('div', { class: 'trust-first glass', role: 'status' }, domain, compare, shares, this.firstDismiss)
    // The first time this session that this phone page is opened on this site (the key is the page's host, not a screen's), the notice stays a little longer.
    let fresh = true
    try { fresh = sessionStorage.getItem(SEEN + location.host) !== '1'; sessionStorage.setItem(SEEN + location.host, '1') } catch { /* private mode */ }
    this.firstMs = fresh ? SETTLE_FIRST_MS : SETTLE_MS
    // A confirmation, then out of the way: after a few seconds it quiets to one slim row (the domain and Compare seal),
    // its sentence folded away; the badge holds the seal from then on. The first press on the controller's face (the
    // person has started to play) takes it away at any point, quiet or not, before its own time is up.
    const first = this.first
    this.quietTimer = setTimeout(() => { if (this.first === first) first.dataset.quiet = '' }, TRUST_QUIET_MS)
    document.addEventListener('pointerdown', this.played, true)
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
  /**
   * In the controls (the bar is up): a notice just under the bar, over the work area, that folds by itself once the seal's
   * moment has passed and has been seen for a while. Before that (a gate card is up): in the card, where it stays.
   */
  private placeFirst() {
    if (!this.first) return
    const bar = this.el.closest('.bar')
    const gate = document.querySelector('.gate-card')
    if (bar?.isConnected) {
      this.firstObserver?.disconnect()
      if (this.railed) return
      this.railed = true
      const node = this.first
      node.classList.remove('glass')
      this.firstDismiss?.remove()
      // Over the work area the notice is a line to read, not a button: a touch on it reaches what is under it.
      const compare = node.querySelector<HTMLElement>('.trust-compare')
      if (compare) compare.replaceWith(h('span', { class: 'trust-compare' }, ...compare.childNodes))
      const ms = Math.max(0, this.momentUntil - performance.now()) + this.firstMs
      notify({
        id: TRUST, tier: 'ceremony', node, ms, icon: false, announce: false, passive: true, closeLabel: 'Dismiss connection notice', closeClass: 'trust-dismiss',
        onClose: () => {
          node.querySelectorAll<HTMLElement>('.connection-seal').forEach(destroySeal)
          if (this.first !== node) return
          this.first = null; this.railed = false
          clearTimeout(this.quietTimer)
          document.removeEventListener('pointerdown', this.played, true)
        },
      })
    } else if (gate) {
      if (this.first.parentElement !== gate) gate.prepend(this.first)
      this.firstObserver?.disconnect()
    }
  }
  /**
   * A press on the face's play surfaces (not the bar, the notice, a sheet or the gamepad's own menus and tools), quiet or
   * not: once someone plays, the badge carries the seal and the notice is out of the way. (The notice now outlives a change
   * of face among the notices, so any press on the gamepad's play area counts.)
   */
  private played = (e: Event) => {
    if (!this.first) return
    const path = e.composedPath().filter((n): n is Element => n instanceof Element)
    if (path.some(n => n.matches('.gp-top, .gp-meta, .gp-motion, .gp-scope, .gp-cue'))) return
    if (path.some(n => n.matches('.pad, .wii, .mouse, .music-face, .kbd, .gp'))) this.clearFirst()
  }
  private clearFirst() {
    clearTimeout(this.quietTimer)
    document.removeEventListener('pointerdown', this.played, true)
    this.firstObserver?.disconnect(); this.firstObserver = null
    const node = this.first
    const railed = this.railed
    this.first = null
    this.railed = false
    if (railed) { dismissNotice(TRUST); return }
    node?.querySelectorAll<HTMLElement>('.connection-seal').forEach(destroySeal)
    node?.remove()
  }
  /** Gamepad uses its own chrome: the connection status lives under its More, with who is here. */
  private placeStatus() {
    const target = document.querySelector('.surface.gp-on .gp-meta-list') ?? document.querySelector('.surface.gp-on .gp-motion') ?? this.slot
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

  /** What this shares, from the connection sheet: the sheet hands its Back step over, so closing it does not close this too. */
  private openShares() {
    this.sheet?.close(true)
    this.closeShares()
    this.closeShares = showShares(this.disconnect)
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
    let exits = (_handOver?: boolean) => {}
    // `handOver`: another layer opens in the same tap (What this shares), so it takes over this sheet's Back step.
    const close = (handOver?: boolean) => { exits(handOver === true); this.clearSeal(); this.sheet = null; wrap.classList.add('out'); setTimeout(() => wrap.remove(), 200) }
    x.addEventListener('click', () => close())
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
      shares.onclick = () => this.openShares()
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
    shares.onclick = () => this.openShares()
    body.replaceChildren(...rows, shares)
  }
}
