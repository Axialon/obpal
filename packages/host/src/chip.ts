/**
 * The pairing chip: how a page offers itself to phones without covering anything. A small glass chip sits in a
 * corner (the ob.Pal mark, "Scan to control", a status dot); it opens into a card with the QR code and the short
 * code, and closes by itself once a phone is in. It takes on the page's look: its accent, font, light or dark
 * surface, and corner radius. It lives in its own shadow root, so page CSS can't break it, and it is a plain
 * button and a labelled group for keyboards and screen readers.
 *
 * It is built from elements, never parsed markup (no innerHTML, outerHTML, insertAdjacentHTML or DOMParser), and styled
 * by a constructed stylesheet, so it works under a strict Content Security Policy and on pages that enforce Trusted
 * Types.
 */
import { formatCode, spokenCode } from '@obpal/core'
import { luminance, parseColor, toHex, type Rgb } from './color'
import { markElement } from './mark'
import type { DeviceLinkInfo, HostStatus, Remote } from './remote'
import { svgElement, type SvgNode } from './svg'

export type ChipCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'inline'

export interface PairingChipOptions {
  /** The Remote it pairs. */
  remote: Remote
  /** Which corner of the viewport it sits in; 'inline' leaves placement to the page. Default 'bottom-right'. */
  corner?: ChipCorner
  /**
   * 'chip' (the default): the corner chip that opens into a card. 'panel': the card's contents alone, always shown and
   * frameless, filling `parent` (the code as wide as it is), for a page that gives pairing a place of its own.
   */
  variant?: 'chip' | 'panel'
  /** The accent (any CSS colour). Default: the page's own (see refresh), else ob.Pal lime. */
  accent?: string
  /** Start open. */
  open?: boolean
  /** The closed chip's words. Default 'Scan to control'. */
  label?: string
  /** Where the chip goes: an element or a shadow root. Default document.body. */
  parent?: HTMLElement | ShadowRoot
  /**
   * Distance from the corner (a CSS length). Default: the page's --obpal-offset, else 16px; --obpal-offset-x and
   * --obpal-offset-y set one axis (a page can move the chip above its own bottom panel on phones, say).
   */
  offset?: string
  /** Light or dark glass. Default 'auto': from the page. */
  scheme?: 'auto' | 'light' | 'dark'
  /** Show the short code beside the QR code. Default true. */
  code?: boolean
  /** A link that opens the controller on this device (to try it without a phone). Default false. */
  testLink?: boolean
  /**
   * The page's own panels and sheets that the card must never cover, as a selector. While one is shown where the card
   * opens, the card folds to the chip (and a mouse resting on the chip doesn't open it); once they're out of the way it
   * opens again if it was open. A click on the chip still opens it. Keep the chip itself clear of them (--obpal-offset*).
   */
  avoid?: string
  /** It opened (true) or closed (false). */
  onToggle?: (open: boolean) => void
}

const LIME: Rgb = [198, 255, 52]
const ACCENT_VARS = ['--obpal-accent', '--accent', '--primary', '--color-primary', '--brand']
const RADIUS_VARS = ['--obpal-radius', '--radius', '--border-radius']
/** How long the card waits for a short code before it shows the QR code alone (a service without codes). */
const CODE_WAIT_MS = 3000
let seq = 0

/** An element with attributes and children (text or nodes). */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  el.append(...kids)
  return el
}

/**
 * One constructed stylesheet for every chip (a Content Security Policy without 'unsafe-inline' allows it), or a
 * <style> where there are none (Safari before 16.4).
 */
let sheet: CSSStyleSheet | null = null
function adoptStyle(root: ShadowRoot) {
  if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
    if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(STYLE) }
    root.adoptedStyleSheets = [sheet]
    return
  }
  const s = document.createElement('style')
  s.textContent = STYLE
  root.appendChild(s)
}

/** The connection's icons (stroke, 24 × 24), as elements. */
const icon = (...kids: SvgNode[]) => svgElement(['svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', class: 'i' }, kids])
const LOCK: SvgNode[] = [['rect', { x: 5.5, y: 10.5, width: 13, height: 9.5, rx: 2.6 }], ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' }]]
const SHIELD: SvgNode[] = [['path', { d: 'M12 3.5 5.5 6v5.2c0 4 2.7 7.4 6.5 8.8 3.8-1.4 6.5-4.8 6.5-8.8V6L12 3.5Z' }], ['path', { d: 'm9 12 2.2 2.2L15.5 10' }]]
const PATH: SvgNode[] = [['circle', { cx: 6, cy: 17.5, r: 2.2 }], ['circle', { cx: 18, cy: 6.5, r: 2.2 }], ['path', { d: 'M8 16.2c3-1 2.3-4.4 5-5.6 1.4-.6 2.6-1.2 3.2-2.4' }]]
/** How often the connections' facts are read again while anyone is connected (Remote.links: their own statistics). */
const LINK_POLL_MS = 2000

const VERIFIED: Record<DeviceLinkInfo['verified'], [short: string, long: string]> = {
  qr: ['QR', 'Verified by the QR code'], code: ['Code', 'Verified by the code typed'], lan: ['Paired', 'Verified by a remembered pairing'],
}

/** The path a connection takes, in a few words, as its selected ICE pair says. */
function pathWords(l: DeviceLinkInfo['link']): string {
  switch (l.path) {
    case 'lan': return 'Direct, on the same network'
    case 'nat': return 'Direct, over the internet'
    case 'direct': return 'Direct, peer to peer'
    case 'relay': return `Relayed through TURN${l.relayProtocol ? ` over ${l.relayProtocol.toUpperCase()}` : ''}, which can’t read it`
    default: return 'Finding the path'
  }
}

const STATUS: Record<HostStatus, string> = {
  starting: 'Starting…', ready: 'Waiting for a phone', connecting: 'Phone found, connecting…', connected: 'Connected', offline: 'Offline, retrying…',
}

export class PairingChip {
  /** The chip's element: its own shadow root holds everything. */
  readonly el: HTMLElement
  private root: ShadowRoot
  private remote: Remote
  private opts: PairingChipOptions
  private $: {
    wrap: HTMLElement; pill: HTMLButtonElement; label: HTMLElement; badge: HTMLElement; mark: HTMLElement; card: HTMLElement; qr: HTMLElement
    codeBox: HTMLElement; code: HTMLElement; site: HTMLElement; status: HTMLElement; live: HTMLElement; here: HTMLAnchorElement | null
    conn: HTMLElement; connMs: HTMLElement; facts: HTMLButtonElement; details: HTMLElement
  }
  private isOpen = false
  /** Opened by a click or a key: stays open. Opened by hovering: closes when the pointer leaves. */
  private pinned = false
  private hoverTimer = 0
  private leaveTimer = 0
  private codeTimer = 0
  private releaseCode: (() => void) | null = null
  private codeSince = 0
  private accent: Rgb = LIME
  private drawn = { url: '', accent: '' }
  private qr: Promise<typeof import('./qr')> | null = null
  private observer: MutationObserver | null = null
  private media: MediaQueryList | null = null
  private refreshQueued = false
  private listeners: [string, (...a: never[]) => void][] = []
  /** The connected devices' links as last read (Remote.links), and the timer that reads them again. */
  private links: DeviceLinkInfo[] = []
  private linkTimer = 0
  /** A page panel (avoid) is where the card opens: it stays folded. */
  private blocked = false
  /** Folded for the page while open: it opens again once the page is clear. */
  private unfold = false
  /** The card as a press on the chip found it (and when): the click that follows goes from there. */
  private pressed: { was: 'closed' | 'peek' | 'pinned'; at: number } | null = null
  private room: { mo: MutationObserver; ro: ResizeObserver | null; seen: WeakSet<Element> } | null = null
  private roomQueued = false

  constructor(opts: PairingChipOptions) {
    this.opts = opts
    this.remote = opts.remote
    const id = `obpal-chip-${++seq}`
    this.el = document.createElement('div')
    this.el.className = 'obpal-chip'
    this.root = this.el.attachShadow({ mode: 'open' })
    adoptStyle(this.root)
    const hidden = { 'aria-hidden': 'true' }
    const $ = {
      mark: h('span', { class: 'mark', ...hidden }), label: h('span', { class: 'label' }, opts.label ?? 'Scan to control'), badge: h('span', { class: 'badge', ...hidden }),
      qr: h('div', { class: 'qr', role: 'img', 'aria-label': 'QR code: scan it with your phone’s camera to control this page' }),
      code: h('span', { class: 'code' }), site: h('b', { class: 'site' }), status: h('span', { class: 'stext' }), live: h('span', { class: 'sr', role: 'status' }),
      here: opts.testLink ? h('a', { class: 'here', target: '_blank', rel: 'noopener' }, 'Use this device') : null,
      connMs: h('span', { class: 'ms' }),
      details: h('div', { class: 'details', id: `${id}-link`, hidden: '' }),
    }
    // The connection, once a phone is in: a lock and the round trip on the chip, a line of facts on the card, and each
    // device's details a tap away. Only what the connections' own statistics say.
    const conn = h('span', { class: 'conn', ...hidden }, icon(...LOCK), $.connMs)
    const facts = h('button', { class: 'facts', type: 'button', 'aria-expanded': 'false', 'aria-controls': `${id}-link`, hidden: '' })
    const pill = h('button', { class: 'pill', type: 'button', 'aria-expanded': 'false', 'aria-controls': id }, $.mark, $.label, $.badge, conn, h('span', { class: 'dot', ...hidden }))
    const codeBox = h('div', { class: 'code-box', 'data-wait': '' }, h('span', { class: 'k' }, 'Or type'), $.code, h('span', { class: 'k at' }, 'at ', $.site))
    const side = h('div', { class: 'side' }, codeBox, h('p', { class: 'status' }, h('span', { class: 'sdot', ...hidden }), $.status), facts, $.details, ...($.here ? [$.here] : []))
    const card = h('div', { class: 'card', id, role: 'group', 'aria-label': 'Pair a phone' }, $.qr, side)
    const wrap = h('div', { class: 'wrap', 'data-corner': opts.corner ?? 'bottom-right', 'data-variant': opts.variant ?? 'chip', 'data-s': 'starting' }, pill, card, $.live)
    this.root.appendChild(wrap)
    this.$ = { ...$, wrap, pill, card, codeBox, conn, facts }
    this.wire()
    ;(opts.parent ?? document.body).appendChild(this.el)
    this.refresh()
    this.watchLooks()
    this.render()
    if (opts.open || opts.variant === 'panel') this.setOpen(true, true)
    else this.syncCode()
    this.watchRoom()
  }

  get expanded() { return this.isOpen }
  /** Open the card; while a page panel is where it opens (avoid), as soon as that's gone. */
  expand() { if (this.blocked) this.unfold = true; else this.setOpen(true, true) }
  collapse() { this.unfold = false; this.setOpen(false) }
  /** As a click on the chip. */
  toggle() { this.unfold = false; this.setOpen(!this.isOpen, true) }

  /**
   * Read the page's look again: its accent (--obpal-accent, else --accent, --primary, --color-primary or --brand),
   * font (--obpal-font, else inherited), light or dark surface (color-scheme, else the background's brightness)
   * and corner radius (--obpal-radius, else --radius or --border-radius). The chip does this by itself when the
   * page's classes, styles or colour scheme change.
   */
  refresh() {
    const cs = getComputedStyle(this.el)
    const prop = (names: string[]) => names.map((n) => cs.getPropertyValue(n).trim()).find(Boolean) ?? ''
    this.accent = toRgb(this.opts.accent ?? '') ?? toRgb(prop(ACCENT_VARS)) ?? LIME
    const font = cs.getPropertyValue('--obpal-font').trim()
    this.el.style.fontFamily = font
    const radius = Math.min(28, Math.max(6, toPx(prop(RADIUS_VARS)) ?? 18))
    const scheme = this.opts.scheme && this.opts.scheme !== 'auto' ? this.opts.scheme : pageScheme(this.el)
    const base = scheme === 'dark' ? pageBackground(this.el) : null
    const w = this.$.wrap
    w.dataset.scheme = scheme
    w.style.setProperty('--a', toHex(this.accent))
    w.style.setProperty('--a-rgb', this.accent.join(' '))
    w.style.setProperty('--a-ink', luminance(this.accent) > 0.35 ? '#0b0d10' : '#ffffff')
    w.style.setProperty('--r', `${radius}px`)
    w.style.setProperty('--pill-r', radius >= 14 ? '999px' : `${radius}px`)
    if (base && luminance(base) < 0.2) w.style.setProperty('--base', base.join(' '))
    else w.style.removeProperty('--base')
    if (this.opts.offset) w.style.setProperty('--obpal-offset', this.opts.offset)
    this.$.mark.replaceChildren(markElement(toHex(this.accent)))
    this.drawQr()
  }

  destroy() {
    for (const [ev, fn] of this.listeners) this.remote.off(ev as 'status', fn as () => void)
    this.listeners = []
    this.observer?.disconnect()
    this.media?.removeEventListener('change', this.queueRefresh)
    this.room?.mo.disconnect()
    this.room?.ro?.disconnect()
    this.room = null
    removeEventListener('resize', this.queueRoom)
    clearTimeout(this.hoverTimer)
    clearTimeout(this.leaveTimer)
    clearTimeout(this.codeTimer)
    clearTimeout(this.linkTimer)
    this.linkTimer = 0
    this.releaseCode?.()
    this.releaseCode = null
    this.el.remove()
  }

  // ---- behaviour ----------------------------------------------------------------------------------------------

  private wire() {
    const { wrap, pill } = this.$
    const now = () => (!this.isOpen ? 'closed' : this.pinned ? 'pinned' : 'peek')
    pill.addEventListener('pointerdown', () => { this.pressed = { was: now(), at: performance.now() } })
    pill.addEventListener('click', () => {
      // It goes from the card as the press found it: a page may close its own panel on the press, and so give the card
      // its room back (and open it) before the click arrives. (A key, or a press long gone, goes from the card as it is.)
      const p = this.pressed
      const was = p && performance.now() - p.at < 1500 ? p.was : now()
      this.pressed = null
      this.unfold = false
      // A click on a card the pointer only peeked at keeps it open; otherwise it opens or closes.
      if (was === 'peek' && this.isOpen) { this.pinned = true; return }
      this.setOpen(was !== 'pinned', true)
    })
    // With a mouse, resting on the chip peeks at the card (not while the page has a panel there); leaving closes a peek.
    pill.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || this.isOpen || this.blocked) return
      clearTimeout(this.hoverTimer)
      this.hoverTimer = window.setTimeout(() => this.setOpen(true, false), 220)
    })
    wrap.addEventListener('pointerenter', () => clearTimeout(this.leaveTimer))
    wrap.addEventListener('pointerleave', (e) => {
      clearTimeout(this.hoverTimer)
      if (e.pointerType !== 'mouse' || !this.isOpen || this.pinned || wrap.matches(':focus-within')) return
      this.leaveTimer = window.setTimeout(() => this.setOpen(false), 380)
    })
    this.$.facts.addEventListener('click', () => {
      const show = this.$.details.hidden
      this.$.details.hidden = !show
      this.$.facts.setAttribute('aria-expanded', String(show))
    })
    wrap.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.isOpen) return
      e.stopPropagation()
      this.setOpen(false)
      pill.focus()
    })
    const on = <K extends 'status' | 'connect' | 'join' | 'leave' | 'disconnect' | 'code' | 'invite'>(ev: K, fn: () => void) => {
      this.remote.on(ev, fn)
      this.listeners.push([ev, fn])
    }
    on('status', () => { this.render(); this.syncCode() })
    // A phone is in: the card has done its job (and doesn't come back when a page panel closes).
    on('connect', () => { this.unfold = false; this.setOpen(false) })
    on('join', () => { this.unfold = false; this.setOpen(false); this.render() })
    on('leave', () => this.render())
    on('disconnect', () => { this.render(); this.syncCode() })
    on('code', () => this.renderCode())
    on('invite', () => this.drawQr())
  }

  private setOpen(open: boolean, pinned = false) {
    // A panel is always open.
    if (this.opts.variant === 'panel' && !open) return
    clearTimeout(this.hoverTimer)
    clearTimeout(this.leaveTimer)
    this.pinned = open && (pinned || this.pinned)
    if (open === this.isOpen) return
    this.isOpen = open
    this.$.wrap.toggleAttribute('data-open', open)
    this.$.pill.setAttribute('aria-expanded', String(open))
    this.syncCode()
    this.render()
    this.opts.onToggle?.(open)
  }

  /** A short code is kept live while the card is open, or while nobody is connected (so it's ready to open). */
  private syncCode() {
    const want = this.opts.code !== false && (this.isOpen || this.remote.status !== 'connected')
    if (want && !this.releaseCode) {
      this.releaseCode = this.remote.wantCode()
      this.codeSince = Date.now()
    } else if (!want && this.releaseCode) {
      this.releaseCode()
      this.releaseCode = null
    }
    this.renderCode()
  }

  // ---- drawing ------------------------------------------------------------------------------------------------

  private render() {
    const r = this.remote
    const n = r.participants.length
    const s = r.status
    const w = this.$.wrap
    w.dataset.s = s
    w.toggleAttribute('data-live', n > 0)
    this.$.badge.textContent = n > 1 ? String(n) : ''
    const text = s === 'connected' ? (n > 1 ? `${n} connected` : `Connected${r.deviceName ? ` · ${r.deviceName}` : ''}`) : STATUS[s]
    this.$.status.textContent = text
    // Said once per change, open or not (the card's own line is hidden while it's closed).
    if (this.$.live.textContent !== text && s !== 'starting') this.$.live.textContent = text
    this.labelPill()
    this.watchLinks(n > 0)
    // Only ever an https (or local http) link: the Remote checks its service, and so does this.
    if (this.$.here && /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(r.pairingUrl)) this.$.here.href = r.pairingUrl
    this.drawQr()
  }

  /** The chip's name for screen readers: who is connected and how (the connection's facts), or its call to pair. */
  private labelPill() {
    const r = this.remote
    const n = r.participants.length
    const who = n > 1 ? `${n} connected` : `Connected${r.deviceName ? ` to ${r.deviceName}` : ''}`
    const how = this.links.length ? `: ${this.factSentence()}` : ''
    this.$.pill.setAttribute('aria-label', n ? `${who}${how}. Pair another phone` : this.opts.label ?? 'Scan to control')
  }

  /** The facts as words to hear: "encrypted end to end, verified by the QR code, direct, 12 ms round trip". */
  private factSentence(): string {
    const ls = this.links
    const via = new Set(ls.map((l) => l.verified))
    const [, , path, rtt] = this.factWords()
    const lower = (w: string) => w.charAt(0).toLowerCase() + w.slice(1)
    return ['encrypted end to end', via.size === 1 ? lower(VERIFIED[ls[0].verified][1]) : 'each verified', lower(path), ...(rtt ? [`${rtt} round trip`] : [])].join(', ')
  }

  /** Read the connections' facts while anyone is connected (every LINK_POLL_MS), and stop when nobody is. */
  private watchLinks(on: boolean) {
    if (on && !this.linkTimer) void this.readLinks()
    if (!on && (this.linkTimer || this.links.length)) {
      clearTimeout(this.linkTimer)
      this.linkTimer = 0
      this.links = []
      this.renderLinks()
    }
  }

  private async readLinks() {
    this.linkTimer = window.setTimeout(() => void this.readLinks(), LINK_POLL_MS)
    const links = await this.remote.links().catch(() => [] as DeviceLinkInfo[])
    if (!this.linkTimer || !this.el.isConnected) return
    this.links = links.filter((l) => l.link.secure)
    this.renderLinks()
    this.labelPill()
  }

  /** Everyone's facts: encrypted, how they were verified, the path (relayed if any is) and the round trip (the slowest). */
  private factWords(): string[] {
    const ls = this.links
    if (!ls.length) return []
    const via = new Set(ls.map((l) => l.verified))
    const relayed = ls.some((l) => l.link.path === 'relay')
    const rtt = Math.max(-1, ...ls.map((l) => l.link.rttMs ?? -1))
    return ['Encrypted', via.size === 1 ? `Verified · ${VERIFIED[ls[0].verified][0]}` : 'Verified', relayed ? 'Relayed' : 'Direct', ...(rtt >= 0 ? [`${rtt} ms`] : [])]
  }

  private renderLinks() {
    const ls = this.links
    const { wrap, facts, details, connMs } = this.$
    wrap.toggleAttribute('data-linked', ls.length > 0)
    wrap.toggleAttribute('data-relayed', ls.some((l) => l.link.path === 'relay'))
    facts.hidden = !ls.length
    if (!ls.length) { details.hidden = true; facts.setAttribute('aria-expanded', 'false') }
    const words = this.factWords()
    const rtt = words.find((w) => w.endsWith(' ms')) ?? ''
    connMs.textContent = rtt
    const fact = (ic: SvgNode[], text: string) => h('span', { class: 'fact' }, icon(...ic), text)
    facts.replaceChildren(...(words.length ? [fact(LOCK, words[0]), fact(SHIELD, words[1]), fact(PATH, rtt ? `${words[2]} · ${rtt}` : words[2])] : []))
    if (words.length) facts.setAttribute('aria-label', `${this.factSentence()}. Connection details`)
    else facts.removeAttribute('aria-label')
    details.replaceChildren(
      ...ls.map((l) => h('div', { class: 'dev' },
        h('b', {}, l.name),
        h('span', {}, 'Encrypted end to end'), ...(l.link.dtls || l.link.cipher ? [h('small', {}, [l.link.dtls, l.link.cipher].filter(Boolean).join(' · '))] : []),
        h('span', {}, VERIFIED[l.verified][1]),
        h('span', {}, pathWords(l.link)),
        ...(l.link.rttMs != null ? [h('span', {}, `Round trip ${l.link.rttMs} ms`)] : []))),
      ...(ls.length ? [h('p', { class: 'k' }, 'The room service only passes the handshake along.')] : []),
    )
  }

  private renderCode() {
    clearTimeout(this.codeTimer)
    const box = this.$.codeBox
    const code = this.opts.code === false ? '' : this.remote.code
    if (code) {
      const changed = this.$.code.textContent !== formatCode(code)
      this.$.code.textContent = formatCode(code)
      this.$.code.setAttribute('aria-label', `code ${spokenCode(code)}`)
      this.$.site.textContent = this.remote.codeSite
      box.hidden = false
      box.removeAttribute('data-wait')
      // A fresh code (the last one was used, or ran out) draws the eye once.
      if (changed && this.isOpen) { box.classList.remove('fresh'); void box.offsetWidth; box.classList.add('fresh') }
      return
    }
    // No code yet: hold its place a moment, then give the card to the QR code alone.
    const waited = Date.now() - this.codeSince
    const waiting = this.opts.code !== false && !!this.releaseCode && waited < CODE_WAIT_MS
    box.hidden = !waiting
    box.toggleAttribute('data-wait', waiting)
    this.$.code.textContent = '··· ··· ···'
    this.$.code.removeAttribute('aria-label')
    this.$.site.textContent = this.remote.codeSite
    if (waiting) this.codeTimer = window.setTimeout(() => this.renderCode(), CODE_WAIT_MS - waited + 20)
  }

  private drawQr() {
    const url = this.remote.pairingUrl
    const accent = toHex(this.accent)
    if (!url || (url === this.drawn.url && accent === this.drawn.accent)) return
    this.drawn = { url, accent }
    this.qr ??= import('./qr')
    void this.qr.then(({ brandedQrElement, plainQrElement }) => {
      if (this.drawn.url !== url || this.drawn.accent !== accent) return
      let svg: SVGSVGElement
      try { svg = brandedQrElement(url, { accent }) } catch { svg = plainQrElement(url) }
      this.$.qr.replaceChildren(svg)
    })
  }

  // ---- the page's look ----------------------------------------------------------------------------------------

  private queueRefresh = () => {
    if (this.refreshQueued) return
    this.refreshQueued = true
    requestAnimationFrame(() => { this.refreshQueued = false; if (this.el.isConnected) this.refresh() })
  }

  /** Themes change by classes, attributes or styles on the root and body, by stylesheets coming and going, or by the system's colour scheme. */
  private watchLooks() {
    // The same changes can show or hide a page panel (a class on the body, say): the room is checked too.
    this.observer = new MutationObserver(() => { this.queueRefresh(); this.queueRoom() })
    for (const n of [document.documentElement, document.body]) this.observer.observe(n, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-bb-theme', 'data-bb-accent', 'data-bb-product'] })
    this.observer.observe(document.head, { childList: true })
    this.media = matchMedia('(prefers-color-scheme: dark)')
    this.media.addEventListener('change', this.queueRefresh)
  }

  // ---- the page's panels (avoid) ------------------------------------------------------------------------------

  /** The panels' own attributes and sizes, elements coming and going, and the window's size tell when to look again. */
  private watchRoom() {
    if (!this.opts.avoid || this.opts.variant === 'panel' || this.opts.corner === 'inline') return
    const mo = new MutationObserver(this.queueRoom)
    mo.observe(document.body, { childList: true })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(this.queueRoom) : null
    ro?.observe(this.$.card)
    this.room = { mo, ro, seen: new WeakSet() }
    addEventListener('resize', this.queueRoom)
    this.checkRoom()
  }

  private queueRoom = () => {
    if (!this.room || this.roomQueued) return
    this.roomQueued = true
    requestAnimationFrame(() => { this.roomQueued = false; this.checkRoom() })
  }

  /** Is a page panel shown where the card opens? Fold as one arrives, and open again once they've all gone. */
  private checkRoom() {
    const room = this.room
    if (!room || !this.el.isConnected) return
    let els: Element[]
    try { els = [...document.querySelectorAll(this.opts.avoid!)] } catch { return }
    for (const el of els) {
      if (room.seen.has(el)) continue
      room.seen.add(el)
      room.mo.observe(el, { attributes: true })
      room.ro?.observe(el)
    }
    // The card keeps its place while closed (it's only hidden), so this is where it opens.
    const card = this.$.card.getBoundingClientRect()
    // Shown is laid out and not hidden (a panel fading in counts from its first frame).
    const blocked = els.some((el) => {
      if (el.contains(this.el) || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return false
      const r = el.getBoundingClientRect()
      return Math.min(r.right, card.right) - Math.max(r.left, card.left) > 1 && Math.min(r.bottom, card.bottom) - Math.max(r.top, card.top) > 1
    })
    if (blocked === this.blocked) return
    this.blocked = blocked
    if (blocked) {
      this.unfold = this.isOpen
      this.setOpen(false)
    } else if (this.unfold) {
      this.unfold = false
      this.setOpen(true, true)
    }
  }
}

/** Any CSS colour (or an "R G B" token) as sRGB, through the browser's own parser where needed. */
function toRgb(v: string): Rgb | null {
  if (!v) return null
  const direct = parseColor(v)
  if (direct) return direct
  if (typeof CSS === 'undefined' || !CSS.supports('color', v)) return null
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#000'
  ctx.fillStyle = v
  return parseColor(String(ctx.fillStyle))
}

function toPx(v: string): number | null {
  const m = /^(-?[\d.]+)(px|rem|em)?$/.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  return m[2] === 'rem' || m[2] === 'em' ? n * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) : n
}

/** The first background with some opacity, from the chip's place outward. */
function pageBackground(el: Element): Rgb | null {
  for (let n: Element | null = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null); n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(n).backgroundColor)
    if (!m) continue
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    if (a >= 0.5) return [r, g, b]
  }
  return null
}

function pageScheme(el: Element): 'light' | 'dark' {
  const scheme = getComputedStyle(el).colorScheme
  if (/\bdark\b/.test(scheme) && !/\blight\b/.test(scheme)) return 'dark'
  if (/\blight\b/.test(scheme) && !/\bdark\b/.test(scheme)) return 'light'
  const bg = pageBackground(el)
  if (bg) return luminance(bg) < 0.3 ? 'dark' : 'light'
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const STYLE = `
:host { display: contents; }
.wrap {
  --ox: var(--obpal-offset-x, var(--obpal-offset, 16px)); --oy: var(--obpal-offset-y, var(--obpal-offset, 16px)); --ease: cubic-bezier(.2, .8, .2, 1); --base: 18 20 26;
  position: fixed; z-index: 2147483000; display: flex; gap: 10px; box-sizing: border-box;
  max-width: calc(100vw - 2 * var(--ox)); color: var(--ink); pointer-events: none;
  font-size: 14px; line-height: 1.35; font-weight: 500; font-style: normal; letter-spacing: normal; text-align: left;
  text-transform: none; text-indent: 0; text-shadow: none; white-space: normal; word-spacing: normal; direction: ltr;
  -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent;
}
.wrap *, .wrap *::before, .wrap *::after { box-sizing: border-box; }
.wrap[data-corner=bottom-right] { right: max(var(--ox), env(safe-area-inset-right)); bottom: max(var(--oy), env(safe-area-inset-bottom)); flex-direction: column-reverse; align-items: flex-end; }
.wrap[data-corner=bottom-left] { left: max(var(--ox), env(safe-area-inset-left)); bottom: max(var(--oy), env(safe-area-inset-bottom)); flex-direction: column-reverse; align-items: flex-start; }
.wrap[data-corner=top-right] { right: max(var(--ox), env(safe-area-inset-right)); top: max(var(--oy), env(safe-area-inset-top)); flex-direction: column; align-items: flex-end; }
.wrap[data-corner=top-left] { left: max(var(--ox), env(safe-area-inset-left)); top: max(var(--oy), env(safe-area-inset-top)); flex-direction: column; align-items: flex-start; }
.wrap[data-corner=inline] { position: relative; display: inline-flex; flex-direction: column; align-items: flex-start; z-index: auto; }
.wrap[data-scheme=dark] { --ink: #f3f5f8; --muted: rgb(243 245 248 / .66); --line: rgb(255 255 255 / .14); --hl: 255 255 255;
  --glass: linear-gradient(150deg, rgb(var(--base) / .8), rgb(var(--base) / .62)); --shadow: 0 18px 46px rgb(0 0 0 / .38), inset 0 1px 0 rgb(255 255 255 / .12); }
.wrap[data-scheme=light] { --ink: #14171c; --muted: rgb(20 23 28 / .62); --line: rgb(15 20 30 / .1); --hl: 0 0 0;
  --glass: linear-gradient(150deg, rgb(255 255 255 / .86), rgb(255 255 255 / .72)); --shadow: 0 16px 40px rgb(15 20 30 / .16), inset 0 1px 0 rgb(255 255 255 / .8); }

.pill, .card { background: var(--glass); border: 1px solid var(--line); box-shadow: var(--shadow);
  -webkit-backdrop-filter: blur(22px) saturate(160%); backdrop-filter: blur(22px) saturate(160%); }
/* Only the chip and the open card take the pointer (a closing card lets go at once): the page gets it everywhere else. */
.pill, .wrap[data-open] .card { pointer-events: auto; }

.pill { position: relative; display: inline-flex; align-items: center; gap: 9px; height: 44px; margin: 0; padding: 0 16px 0 6px;
  border-radius: var(--pill-r, 999px); color: inherit; font: inherit; font-weight: 650; cursor: pointer; touch-action: manipulation;
  transition: border-color .2s var(--ease), transform .12s var(--ease), padding .24s var(--ease); }
.pill:hover { border-color: rgb(var(--a-rgb) / .55); }
.pill:active { transform: scale(.98); }
.pill:focus-visible { outline: 2px solid var(--a); outline-offset: 3px; }
.wrap[data-open] .pill { border-color: rgb(var(--a-rgb) / .7); }
.mark { display: grid; place-items: center; width: 32px; height: 32px; flex: none; }
.mark svg { width: 32px; height: 32px; overflow: visible; display: block; }
.label { white-space: nowrap; }
.wrap[data-live]:not([data-open]) .label { display: none; }
.wrap[data-live]:not([data-open]) .pill { padding: 0 12px 0 6px; }
.badge:empty { display: none; }
.badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center;
  background: rgb(var(--hl) / .12); font-variant-numeric: tabular-nums; }
.dot, .sdot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--muted); }
.wrap[data-s=ready] :is(.dot, .sdot) { background: var(--a); box-shadow: 0 0 0 3px rgb(var(--a-rgb) / .2); animation: obpal-pulse 1.8s ease-in-out infinite; }
.wrap[data-s=connecting] :is(.dot, .sdot) { background: #fcd34d; }
.wrap[data-s=connected] :is(.dot, .sdot) { background: #6ee7b7; }
.wrap[data-s=offline] :is(.dot, .sdot) { background: #fb7185; }
@keyframes obpal-pulse { 50% { opacity: .4; } }

.card { display: flex; align-items: center; gap: 18px; padding: 16px 18px 16px 16px; border-radius: var(--r, 18px); max-width: 100%;
  transform-origin: var(--origin, bottom right); opacity: 0; visibility: hidden; transform: translateY(8px) scale(.96);
  transition: opacity .18s var(--ease), transform .24s var(--ease), visibility 0s linear .24s; }
.wrap[data-corner^=top] .card { transform: translateY(-8px) scale(.96); }
.wrap[data-corner$=left] { --origin: bottom left; }
.wrap[data-corner=top-right] { --origin: top right; }
.wrap[data-corner=top-left] { --origin: top left; }
.wrap[data-corner=inline] .card { display: none; }
.wrap[data-corner=inline][data-open] .card { display: flex; }
.wrap[data-open] .card { opacity: 1; visibility: visible; transform: none; transition-delay: 0s; }
/* The panel: the card's contents in the page's own frame, the code as wide as the frame. */
.wrap[data-variant=panel] { position: relative; inset: auto; display: block; z-index: auto; max-width: none; }
.wrap[data-variant=panel] .pill { display: none; }
.wrap[data-variant=panel] .card { flex-direction: column; align-items: stretch; gap: 14px; padding: 0; border: 0; border-radius: 0; background: none;
  box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; transition: none; }
.wrap[data-variant=panel] .qr { width: 100%; height: auto; aspect-ratio: 1; border-radius: 16px; }
.wrap[data-variant=panel] .side { gap: 8px; }
.qr { width: var(--obpal-qr, 168px); height: var(--obpal-qr, 168px); flex: none; border-radius: 10px; background: #fff;
  box-shadow: 0 0 0 1.5px rgb(var(--a-rgb) / .55), 0 10px 30px rgb(var(--a-rgb) / .2); }
.qr svg { display: block; width: 100%; height: 100%; }
.side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.code-box { display: flex; flex-direction: column; gap: 2px; }
.code-box[hidden] { display: none; }
.k { font-size: 12px; color: var(--muted); }
.k b { color: var(--ink); font-weight: 650; white-space: nowrap; }
.code { font-size: 25px; font-weight: 750; letter-spacing: .06em; font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1.2; }
.code-box[data-wait] .code { color: var(--muted); }
.code-box.fresh .code { animation: obpal-fresh .6s var(--ease); }
@keyframes obpal-fresh { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.status { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; color: var(--muted); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.here { align-self: flex-start; font-size: 12px; font-weight: 600; color: var(--muted); text-decoration: none; border-bottom: 1px solid rgb(var(--hl) / .25); }
.here:hover { color: var(--ink); }
.here:focus-visible { outline: 2px solid var(--a); outline-offset: 2px; border-radius: 3px; }
/* The connection (renderLinks): a lock and the round trip on the chip, facts on the card, each device's details a tap away. */
.wrap[data-scheme=dark] { --ok: #6ee7b7; --warn: #fcd34d; }
.wrap[data-scheme=light] { --ok: #0b8a60; --warn: #b45309; }
.i { width: 14px; height: 14px; flex: none; display: block; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.conn { display: none; align-items: center; gap: 4px; font-size: 12px; font-weight: 650; color: var(--muted); font-variant-numeric: tabular-nums; }
.wrap[data-linked] .conn { display: inline-flex; }
.conn .i, .fact .i { color: var(--ok); }
.wrap[data-relayed] :is(.conn .i, .fact:last-child .i) { color: var(--warn); }
.ms:empty { display: none; }
.facts { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.facts[hidden] { display: none; }
.facts:focus-visible { outline: 2px solid var(--a); outline-offset: 3px; border-radius: 12px; }
.fact { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px 0 7px; border-radius: 999px; font-size: 12px; font-weight: 650;
  font-variant-numeric: tabular-nums; white-space: nowrap; background: rgb(var(--hl) / .07); border: 1px solid var(--line); }
.facts:hover .fact { border-color: rgb(var(--a-rgb) / .45); }
.details { display: flex; flex-direction: column; gap: 6px; max-width: 260px; font-size: 12px; line-height: 1.4; }
.details[hidden] { display: none; }
.dev { display: flex; flex-direction: column; gap: 1px; padding: 8px 10px; border-radius: min(12px, var(--r, 18px)); background: rgb(var(--hl) / .05); border: 1px solid var(--line); }
.dev b { font-size: 12.5px; font-weight: 700; }
.dev small { color: var(--muted); overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .facts { justify-content: center; }
  .details { max-width: none; text-align: left; }
  .card { flex-direction: column; align-items: stretch; text-align: center; gap: 12px; padding: 14px; }
  .qr { align-self: center; }
  .side, .code-box { align-items: center; }
  .status { justify-content: center; }
  .here { align-self: center; }
}
@media (prefers-reduced-motion: reduce) {
  .pill, .card, .wrap[data-s] :is(.dot, .sdot), .code-box.fresh .code { transition: none !important; animation: none !important; }
  .card { transform: none !important; }
}
@media (forced-colors: active) {
  .pill, .card { border: 1px solid CanvasText; }
  .dot, .sdot { forced-color-adjust: none; }
}
`
