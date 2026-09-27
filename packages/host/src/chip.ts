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
import type { HostStatus, Remote } from './remote'

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
    }
    const pill = h('button', { class: 'pill', type: 'button', 'aria-expanded': 'false', 'aria-controls': id }, $.mark, $.label, $.badge, h('span', { class: 'dot', ...hidden }))
    const codeBox = h('div', { class: 'code-box', 'data-wait': '' }, h('span', { class: 'k' }, 'Or type'), $.code, h('span', { class: 'k at' }, 'at ', $.site))
    const side = h('div', { class: 'side' }, codeBox, h('p', { class: 'status' }, h('span', { class: 'sdot', ...hidden }), $.status), ...($.here ? [$.here] : []))
    const card = h('div', { class: 'card', id, role: 'group', 'aria-label': 'Pair a phone' }, $.qr, side)
    const wrap = h('div', { class: 'wrap', 'data-corner': opts.corner ?? 'bottom-right', 'data-variant': opts.variant ?? 'chip', 'data-s': 'starting' }, pill, card, $.live)
    this.root.appendChild(wrap)
    this.$ = { ...$, wrap, pill, card, codeBox }
    this.wire()
    ;(opts.parent ?? document.body).appendChild(this.el)
    this.refresh()
    this.watchLooks()
    this.render()
    if (opts.open || opts.variant === 'panel') this.setOpen(true, true)
    else this.syncCode()
  }

  get expanded() { return this.isOpen }
  expand() { this.setOpen(true, true) }
  collapse() { this.setOpen(false) }
  toggle() { this.setOpen(!this.isOpen, true) }

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
    clearTimeout(this.hoverTimer)
    clearTimeout(this.leaveTimer)
    clearTimeout(this.codeTimer)
    this.releaseCode?.()
    this.releaseCode = null
    this.el.remove()
  }

  // ---- behaviour ----------------------------------------------------------------------------------------------

  private wire() {
    const { wrap, pill } = this.$
    pill.addEventListener('click', () => {
      // A click on a card the pointer only peeked at keeps it open; otherwise it opens or closes.
      if (this.isOpen && !this.pinned) { this.pinned = true; return }
      this.setOpen(!this.isOpen, true)
    })
    // With a mouse, resting on the chip peeks at the card; leaving closes a peek.
    pill.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || this.isOpen) return
      clearTimeout(this.hoverTimer)
      this.hoverTimer = window.setTimeout(() => this.setOpen(true, false), 220)
    })
    wrap.addEventListener('pointerenter', () => clearTimeout(this.leaveTimer))
    wrap.addEventListener('pointerleave', (e) => {
      clearTimeout(this.hoverTimer)
      if (e.pointerType !== 'mouse' || !this.isOpen || this.pinned || wrap.matches(':focus-within')) return
      this.leaveTimer = window.setTimeout(() => this.setOpen(false), 380)
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
    // A phone is in: the card has done its job.
    on('connect', () => this.setOpen(false))
    on('join', () => { this.setOpen(false); this.render() })
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
    const label = this.opts.label ?? 'Scan to control'
    this.$.pill.setAttribute('aria-label', n ? `${n > 1 ? `${n} connected` : `Connected${r.deviceName ? ` to ${r.deviceName}` : ''}`}. Pair another phone` : label)
    // Only ever an https (or local http) link: the Remote checks its service, and so does this.
    if (this.$.here && /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(r.pairingUrl)) this.$.here.href = r.pairingUrl
    this.drawQr()
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
    this.observer = new MutationObserver(this.queueRefresh)
    for (const n of [document.documentElement, document.body]) this.observer.observe(n, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-bb-theme', 'data-bb-accent', 'data-bb-product'] })
    this.observer.observe(document.head, { childList: true })
    this.media = matchMedia('(prefers-color-scheme: dark)')
    this.media.addEventListener('change', this.queueRefresh)
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
  max-width: calc(100vw - 2 * var(--ox)); color: var(--ink);
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
.qr { width: 168px; height: 168px; flex: none; border-radius: 10px; background: #fff;
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
@media (max-width: 480px) {
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
