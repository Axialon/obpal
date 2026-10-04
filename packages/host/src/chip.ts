/**
 * The pairing chip: how a page offers itself to phones without covering anything. A small glass chip sits in a
 * corner (the ob.Pal mark, "Scan to control", a status dot); it opens into a card with the QR code and the short
 * code. Its QR dots become the connection seal and stay in the card once a phone is in. It takes on the page's look: its accent, font, light or dark
 * surface, and corner radius. It lives in its own shadow root, so page CSS can't break it, and it is a plain
 * button and a labelled group for keyboards and screen readers.
 *
 * It is built from elements, never parsed markup (no innerHTML, outerHTML, insertAdjacentHTML or DOMParser), and styled
 * by a constructed stylesheet, so it works under a strict Content Security Policy and on pages that enforce Trusted
 * Types.
 */
import { destroySeal, refreshSeal, sealElement, SEAL_STYLE } from './seal'
import { SealSurface, SEAL_SURFACE_STYLE } from './seal-surface'
import { DotLoader, DOT_LOADER_STYLE } from './dot-field'
import { communityMarker } from './origin'
import { formatCode, spokenCode } from '@obpal/core'
import { contrast, luminance, parseColor, toHex, type Rgb } from './color'
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
  /**
   * Light dismiss: a press anywhere outside the chip and its card, or Escape anywhere on the page, folds any open card,
   * before a phone is in as well, and in every view (it stays folded until the chip is clicked again). Default false:
   * only a connected card in its resting view closes so.
   */
  lightDismiss?: boolean
  /** The page's own controls that open and close the card (a people chip's +), as a selector: a press on them is theirs. */
  toggles?: string
  /**
   * Fold the card this long after a newly arrived phone's seal is revealed, leaving the seal on the chip; it holds while
   * it is in use, as the default fold does. A phone already seen on this page, connecting again, doesn't open the card
   * at all. Default: every connection opens it, and it folds about eight seconds after the seal settles.
   */
  foldAfterSealMs?: number
  /** It opened (true) or closed (false). */
  onToggle?: (open: boolean) => void
}

/**
 * How a settling chip (PairingChipOptions.foldAfterSealMs) answers phones arriving, apart from the page: it opens to
 * reveal a phone's seal the first time that phone is seen, and folds a set time after the last thing that opened it.
 */
export class ChipSettle {
  private seen = new Set<string>()
  constructor(readonly foldAfterMs: number) {}
  /** A phone joined: whether it's new to this page, and when (from now) the card should fold. */
  join(id: string): { fresh: boolean; foldInMs: number } {
    return { fresh: !this.seen.has(id), foldInMs: this.foldAfterMs + 1500 }
  }
  /** A phone's seal is revealed after `delayMs`: whether the card opens for it, and when it folds. */
  seal(id: string, delayMs: number): { open: boolean; foldInMs: number } {
    const fresh = !this.seen.has(id)
    this.seen.add(id)
    return { open: fresh, foldInMs: delayMs + this.foldAfterMs }
  }
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
    if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(STYLE + SEAL_STYLE + SEAL_SURFACE_STYLE + DOT_LOADER_STYLE) }
    root.adoptedStyleSheets = [sheet]
    return
  }
  const s = document.createElement('style')
  s.textContent = STYLE + SEAL_STYLE + SEAL_SURFACE_STYLE + DOT_LOADER_STYLE
  root.appendChild(s)
}

/** The connection's icons (stroke, 24 × 24), as elements. */
const icon = (...kids: SvgNode[]) => svgElement(['svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', class: 'i' }, kids])
const LOCK: SvgNode[] = [['rect', { x: 5.5, y: 10.5, width: 13, height: 9.5, rx: 2.6 }], ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' }]]
const SHIELD: SvgNode[] = [['path', { d: 'M12 3.5 5.5 6v5.2c0 4 2.7 7.4 6.5 8.8 3.8-1.4 6.5-4.8 6.5-8.8V6L12 3.5Z' }], ['path', { d: 'm9 12 2.2 2.2L15.5 10' }]]
const CLOSE: SvgNode[] = [['path', { d: 'M7 7l10 10M17 7 7 17' }]]
const PATH: SvgNode[] = [['circle', { cx: 6, cy: 17.5, r: 2.2 }], ['circle', { cx: 18, cy: 6.5, r: 2.2 }], ['path', { d: 'M8 16.2c3-1 2.3-4.4 5-5.6 1.4-.6 2.6-1.2 3.2-2.4' }]]
/** How often the connections' facts are read again while anyone is connected (Remote.links: their own statistics). */
const LINK_POLL_MS = 2000
/**
 * A card a phone's arrival opened folds by itself this long after its seal has settled (the seal's flight takes
 * SEAL_FLIGHT_MS). It holds, and looks again after SETTLE_HOLD_MS, while anyone is using it: a pointer on it, focus in it,
 * the comparison view, or another phone being added.
 */
const SETTLE_MS = 8000
const SETTLE_HOLD_MS = 3000
/** The seal's own moment: it starts a beat after the phone says it is ready, and flies for this long. */
const SEAL_FLIGHT_MS = 1200
/** A phone's join comes before its seal; the seal normally lands within this. */
const JOIN_GRACE_MS = 3000
/** A click this soon after a press that closed the card by light dismiss belongs to that press (it must not open it again). */
const DISMISS_GRACE_MS = 700

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
  private readonly pillLoader = new DotLoader({ size: 24, label: 'Waiting for a phone' })
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
  private surface: SealSurface
  private seals = h('div', { class: 'seals', part: 'rail' })
  private compare = h('button', { class: 'seal-view', type: 'button', hidden: '' }, 'Compare connection seal')
  private back = h('button', { class: 'seal-back', type: 'button' }, 'Back to pairing')
  private sealKey = ''
  private compactSeal = h('span', { class: 'chip-seal' })
  private compactKey = ''
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
  /** The fold a phone's arrival schedules (see SETTLE_MS), and when the last light dismiss closed the card. */
  private settleTimer = 0
  private dismissedAt = -Infinity
  private closeX = h('button', { class: 'card-x', type: 'button', 'aria-label': 'Close pairing card' }, icon(...CLOSE))
  /** A chip that settles on its own time (foldAfterSealMs): its memory of the phones it has seen. */
  private settling: ChipSettle | null = null

  constructor(opts: PairingChipOptions) {
    this.opts = opts
    this.remote = opts.remote
    const id = `obpal-chip-${++seq}`
    this.el = document.createElement('div')
    this.el.className = 'obpal-chip'
    // Says so on the page, for the page's own handlers of the chip (a phone's scanner leaves an open card's fold alone).
    if (opts.lightDismiss) this.el.setAttribute('data-light-dismiss', '')
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
    const pill = h('button', { class: 'pill', type: 'button', 'aria-expanded': 'false', 'aria-controls': id }, $.mark, $.label, $.badge, conn, this.compactSeal, this.pillLoader.el)
    const codeBox = h('div', { class: 'code-box', 'data-wait': '' }, h('span', { class: 'k' }, 'Or type'), $.code, h('span', { class: 'k at' }, 'at ', $.site))
    const side = h('div', { class: 'side' }, codeBox, h('p', { class: 'status' }, h('span', { class: 'sdot', ...hidden }), $.status), facts, $.details, ...($.here ? [$.here] : []))
    const domain = new URL(this.remote.pairingUrl || `https://${this.remote.codeSite}`).hostname
    const details = h('details', { class: 'scan-cues' }, h('summary', { 'aria-label': 'Pairing details' }, 'ⓘ'), h('b', {}, domain), h('p', {}, "Opens in your phone's browser · no app · no account"), h('p', {}, `Check your camera shows ${domain}`))
    details.append(codeBox, facts, $.details, ...($.here ? [$.here] : []))
    const cues = h('div', { class: 'pair-icons' })
    const camera: SvgNode[] = [['rect', { x: 4, y: 6, width: 16, height: 13, rx: 3 }], ['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'm8 6 1-2h6l1 2' }]]
    const phone: SvgNode[] = [['rect', { x: 7, y: 3, width: 10, height: 18, rx: 2 }], ['path', { d: 'm4 4 16 16' }]]
    const account: SvgNode[] = [['circle', { cx: 12, cy: 8, r: 3 }], ['path', { d: 'M5 20v-2a7 7 0 0 1 14 0M4 4l16 16' }]]
    for (const [label, glyph] of [['Scan with your phone’s camera', camera], ['No app needed', phone], ['No account needed', account], ['Encrypted, peer to peer', LOCK]] as [string, SvgNode[]][]) {
      cues.append(h('span', { role: 'img', 'aria-label': label, title: label }, icon(...glyph)))
    }
    side.append(cues, details, this.compare)
    const card = h('div', { class: 'card', id, role: 'group', 'aria-label': 'Pair a phone' }, $.qr, side, this.seals, this.closeX)
    this.compare.onclick = () => { card.setAttribute('data-seal-view', ''); this.back.focus() }
    this.back.onclick = () => { card.removeAttribute('data-seal-view'); this.$.qr.querySelector<HTMLButtonElement>('.seal-peer')?.focus() }
    this.surface = new SealSurface({ add: () => { void this.remote.inviteAnotherPhone(); card.removeAttribute('data-seal-view') }, compare: () => this.compare.click() })
    $.qr.removeAttribute('role')
    $.qr.replaceChildren(this.surface.el)
    side.append(this.surface.addControl)
    const wrap = h('div', { class: 'wrap', 'data-corner': opts.corner ?? 'bottom-right', 'data-variant': opts.variant ?? 'chip', 'data-s': 'starting' }, pill, card, $.live)
    this.root.appendChild(wrap)
    const marker = communityMarker(location.origin)
    if (marker) wrap.append(marker)
    this.$ = { ...$, wrap, pill, card, codeBox, conn, facts }
    // The requested initial state precedes layout; later opens retain their transition.
    const initiallyOpen = !!(opts.open || opts.variant === 'panel')
    if (initiallyOpen) {
      this.isOpen = this.pinned = true
      wrap.setAttribute('data-open', '')
      pill.setAttribute('aria-expanded', 'true')
    }
    if (opts.foldAfterSealMs !== undefined && opts.variant !== 'panel') this.settling = new ChipSettle(Math.max(0, opts.foldAfterSealMs))
    this.wire()
    ;(opts.parent ?? document.body).appendChild(this.el)
    this.refresh()
    this.watchLooks()
    this.render()
    this.syncCode()
    if (initiallyOpen) this.opts.onToggle?.(true)
    this.watchRoom()
  }

  get expanded() { return this.isOpen }
  /** Open the card; while a page panel is where it opens (avoid), as soon as that's gone. */
  expand() { if (this.blocked) this.unfold = true; else this.setOpen(true, true) }
  collapse() { clearTimeout(this.settleTimer); this.unfold = false; this.setOpen(false) }
  /**
   * As a click on the + of a page's people chip. A connected card that is open folds again; a folded one opens on a fresh
   * code to add another phone. (A press that just closed the card by light dismiss was this click: it stays closed.)
   */
  toggle() {
    this.unfold = false
    clearTimeout(this.settleTimer)
    if (performance.now() - this.dismissedAt < DISMISS_GRACE_MS) return
    if (!this.remote.seals.length) { this.setOpen(!this.isOpen, true); return }
    if (this.isOpen) { this.fold(); return }
    this.expand()
    this.surface.add()
  }

  /** Close the card by the person's own act: a fresh code being shown to add a phone ends with it, and the seal comes back. */
  private fold() {
    this.unfold = false
    this.surface.cancelAdding()
    this.setOpen(false)
  }

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
    const ink = scheme === 'light' ? '#14171c' : '#f3f5f8'
    const background: Rgb = scheme === 'light' ? [255, 255, 255] : base ?? [18, 20, 26]
    const familyInk = toRgb(prop(['--bb-ink']))
    w.style.setProperty('--seal-ink', familyInk && contrast(familyInk, background) >= 7 ? toHex(familyInk) : ink)
    w.style.setProperty('--seal-plate', prop(['--bb-sheet']) || (scheme === 'light' ? '#ffffff' : '#12141a'))
    w.style.setProperty('--r', `${radius}px`)
    w.style.setProperty('--pill-r', radius >= 14 ? '999px' : `${radius}px`)
    if (base && luminance(base) < 0.2) w.style.setProperty('--base', base.join(' '))
    else w.style.removeProperty('--base')
    if (this.opts.offset) w.style.setProperty('--obpal-offset', this.opts.offset)
    this.$.mark.replaceChildren(markElement(toHex(this.accent)))
    this.drawQr()
    this.seals.querySelectorAll<HTMLElement>('.connection-seal').forEach(refreshSeal)
    this.compactSeal.querySelectorAll<HTMLElement>('.connection-seal').forEach(refreshSeal)
  }

  destroy() {
    this.surface.destroy()
    this.pillLoader.destroy()
    this.seals.querySelectorAll<HTMLElement>('.connection-seal').forEach(destroySeal)
    this.compactSeal.querySelectorAll<HTMLElement>('.connection-seal').forEach(destroySeal)
    for (const [ev, fn] of this.listeners) this.remote.off(ev as 'status', fn as () => void)
    this.listeners = []
    this.observer?.disconnect()
    this.media?.removeEventListener('change', this.queueRefresh)
    this.room?.mo.disconnect()
    this.room?.ro?.disconnect()
    this.room = null
    removeEventListener('resize', this.queueRoom)
    document.removeEventListener('transitionend', this.roomMotion, true)
    document.removeEventListener('transitioncancel', this.roomMotion, true)
    clearTimeout(this.hoverTimer)
    clearTimeout(this.leaveTimer)
    clearTimeout(this.codeTimer)
    clearTimeout(this.linkTimer)
    this.linkTimer = 0
    clearTimeout(this.settleTimer)
    document.removeEventListener('keydown', this.onDocKey)
    document.removeEventListener('pointerdown', this.onDocPress, true)
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
      // A click on the chip is a choice: it outranks a pending fold.
      clearTimeout(this.settleTimer)
      // A click on a card the pointer only peeked at keeps it open; otherwise it opens or closes.
      if (was === 'peek' && this.isOpen) { this.pinned = true; this.labelPill() }
      else if (was === 'pinned') this.fold()
      else this.setOpen(true, true)
      if (this.isOpen && this.remote.seals.length) this.$.card.setAttribute('data-seal-view', '')
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
    // A press in the card (comparing seals, adding a phone, its details) means someone is using it: it stays.
    this.$.card.addEventListener('pointerdown', () => clearTimeout(this.settleTimer))
    this.$.facts.addEventListener('click', () => {
      const show = this.$.details.hidden
      this.$.details.hidden = !show
      this.$.facts.setAttribute('aria-expanded', String(show))
    })
    wrap.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.isOpen) return
      e.stopPropagation()
      this.fold()
      pill.focus()
    })
    // The card's own close (a connected card has one), and the page's two ways to dismiss it: Escape anywhere, and a press
    // outside it. Both leave the comparison and a phone being added alone (they are in use), and neither moves focus.
    this.closeX.addEventListener('click', () => { this.fold(); pill.focus() })
    document.addEventListener('keydown', this.onDocKey)
    document.addEventListener('pointerdown', this.onDocPress, true)
    const on = <K extends 'status' | 'connect' | 'join' | 'leave' | 'disconnect' | 'code' | 'invite' | 'attention'>(ev: K, fn: () => void) => {
      this.remote.on(ev, fn)
      this.listeners.push([ev, fn])
    }
    const reveal = (s: { id: string; seal: import('@obpal/core').ConnectionSeal; delayMs: number }) => {
      this.surface.sync(this.remote.seals)
      this.surface.reveal(s.id, s.delayMs)
      if (!this.settling) { this.expand(); this.settle(s.delayMs + SEAL_FLIGHT_MS + SETTLE_MS); return }
      // On its own time (foldAfterSealMs): a new phone's seal is shown, then the card folds and leaves the seal on the chip.
      const { open, foldInMs } = this.settling.seal(s.id, s.delayMs)
      if (open) this.expand()
      if (open || this.isOpen || this.unfold) this.settle(foldInMs)
    }
    this.remote.on('seal', reveal)
    this.listeners.push(['seal', reveal as (...a: never[]) => void])
    on('status', () => { this.render(); this.syncCode() })
    // A phone's arrival opens the card to show its seal, and the card folds again once the seal has settled (a phone that
    // sends no seal gets the same time from its join). A chip on its own time opens for a new phone's seal, not for a
    // connection, and one left open folds a while after anyone joins.
    on('connect', () => { if (!this.settling) { this.expand(); this.settle(JOIN_GRACE_MS + SETTLE_MS) } })
    const joined = (p: { id: string }) => {
      if (!this.settling) { this.expand(); this.settle(JOIN_GRACE_MS + SETTLE_MS) }
      else if (this.isOpen || this.unfold) this.settle(this.settling.join(p.id).foldInMs)
      this.render()
    }
    this.remote.on('join', joined)
    this.listeners.push(['join', joined as (...a: never[]) => void])
    on('leave', () => this.render())
    on('attention', () => this.render())
    on('disconnect', () => { this.render(); this.syncCode() })
    on('code', () => this.renderCode())
    on('invite', () => this.drawQr())
    let inputAt = -Infinity
    const activity = (who: { id: string }) => { const now = performance.now(); if (this.remote.inputActive(who.id) && now - inputAt > 700) { inputAt = now; this.surface.activity() } }
    this.remote.on('input', activity)
    this.listeners.push(['input', activity as (...a: never[]) => void])
  }

  private setOpen(open: boolean, pinned = false) {
    // A panel is always open.
    if (this.opts.variant === 'panel' && !open) return
    clearTimeout(this.hoverTimer)
    clearTimeout(this.leaveTimer)
    this.pinned = open && (pinned || this.pinned)
    if (open === this.isOpen) return
    this.isOpen = open
    if (!open) {
      // (A card folded for a page panel keeps its fold timer: once its time is up, it stays folded when the panel goes.)
      if (!this.unfold) clearTimeout(this.settleTimer)
      this.$.card.removeAttribute('data-seal-view')
      // A light-dismiss card opens again on its QR code, its details folded.
      if (this.opts.lightDismiss) this.$.card.querySelector('details.scan-cues')?.removeAttribute('open')
    }
    this.$.wrap.toggleAttribute('data-open', open)
    this.$.pill.setAttribute('aria-expanded', String(open))
    this.syncCode()
    this.render()
    this.opts.onToggle?.(open)
  }

  /** Fold the card after `ms`, unless it is in use then (see SETTLE_MS). */
  private settle(ms: number) {
    if (this.opts.variant === 'panel') return
    clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => this.settled(), ms)
  }

  private settled() {
    if (!this.el.isConnected) return
    // Folded for a page panel meanwhile: it no longer opens again when the panel goes.
    if (!this.isOpen) { this.unfold = false; return }
    // (Focus counts only when it is showing, a keyboard's: a click leaves the pill focused, and that must not hold the card open.)
    const inUse = this.$.wrap.matches(':hover') || !!this.root.querySelector(':focus-visible') || this.$.card.hasAttribute('data-seal-view') || this.surface.isAdding
    if (inUse) { this.settleTimer = window.setTimeout(() => this.settled(), SETTLE_HOLD_MS); return }
    this.setOpen(false)
  }

  /**
   * Escape closes a connected card from anywhere on the page (unless something else already took the key); with light
   * dismiss, any open card, and a card folded for a page panel no longer opens again when it goes.
   */
  private onDocKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || this.opts.variant === 'panel') return
    const light = !!this.opts.lightDismiss
    if (light ? !this.isOpen && !this.unfold : !this.isOpen || !this.remote.participants.length) return
    const t = e.target instanceof Element ? e.target : null
    if (t && t !== document.body && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], dialog, [role=dialog]') && !this.el.contains(t)) return
    // (Folded for a panel: the key is the panel's.)
    if (!this.isOpen) { this.unfold = false; return }
    // The key is spent here: a layer beneath (the page's own Escape) does not also act on it.
    e.preventDefault()
    this.fold()
  }

  /**
   * A press outside a connected card in its resting view lets it go. (The comparison and a phone being added stay.) With
   * light dismiss, a press outside any open card and the page's own toggles (PairingChipOptions.toggles) folds it.
   */
  private onDocPress = (e: PointerEvent) => {
    if (this.opts.variant === 'panel') return
    const path = e.composedPath()
    if (path.includes(this.el)) return
    if (this.opts.lightDismiss) {
      if (!this.isOpen && !this.unfold) return
      const toggles = this.opts.toggles
      if (toggles && path.some((n) => n instanceof Element && n.matches(toggles))) return
      if (this.isOpen) this.dismissedAt = performance.now()
      this.fold()
      return
    }
    if (!this.isOpen || !this.pinned || !this.remote.participants.length) return
    if (this.$.card.hasAttribute('data-seal-view') || this.surface.isAdding) return
    this.dismissedAt = performance.now()
    this.setOpen(false)
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
    const busy = !this.isOpen && ['starting', 'ready', 'connecting', 'offline'].includes(s)
    this.pillLoader.el.hidden = !busy
    this.pillLoader.el.setAttribute('aria-label', STATUS[s])
    if (busy) this.pillLoader.start(); else this.pillLoader.finish()
    w.toggleAttribute('data-live', n > 0)
    this.$.badge.textContent = n > 1 ? String(n) : ''
    const paused = r.participants.filter((p) => p.paused).length
    const text = s === 'connected' ? (paused === n ? 'Phone paused' : n > 1 ? `${n} connected${paused ? ` · ${paused} paused` : ''}` : `Connected${r.deviceName ? ` · ${r.deviceName}` : ''}`) : STATUS[s]
    this.$.label.textContent = paused ? (paused === n ? 'Phone paused' : `${paused} paused`) : this.opts.label ?? 'Scan to control'
    this.$.status.textContent = text
    // Said once per change, open or not (the card's own line is hidden while it's closed).
    if (this.$.live.textContent !== text && s !== 'starting') this.$.live.textContent = text
    this.labelPill()
    this.watchLinks(n > 0)
    // Only ever an https (or local http) link: the Remote checks its service, and so does this.
    if (this.$.here && /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(r.pairingUrl)) this.$.here.href = r.pairingUrl
    const key = r.seals.map(s => `${s.id}:${s.name}:${s.seal.join('-')}`).join('|')
    const sealChanged = key !== this.sealKey
    if (sealChanged) {
      this.sealKey = key
      this.seals.querySelectorAll<HTMLElement>('.connection-seal').forEach(destroySeal)
      this.seals.replaceChildren(this.back, ...r.seals.map((s) => h('div', {}, h('b', {}, s.name), sealElement(s.seal), h('p', {}, 'Check both screens show the same seal'))))
    }
    this.seals.hidden = !r.seals.length
    this.compare.hidden = !r.seals.length
    // Keep the most recently paired phone's seal in the chip; the full view compares every connection.
    const compact = r.seals.at(-1)
    const compactKey = compact?.seal.join('-') ?? ''
    if (compactKey !== this.compactKey) {
      this.compactKey = compactKey
      this.compactSeal.querySelectorAll<HTMLElement>('.connection-seal').forEach(destroySeal)
      this.compactSeal.replaceChildren(...(compact ? [sealElement(compact.seal, true)] : []))
    }
    this.compactSeal.hidden = !compact
    this.surface.sync(r.seals)
    this.queueRoom()
    if (!r.seals.length) this.$.card.removeAttribute('data-seal-view')
    this.drawQr()
  }

  /** The chip's name for screen readers: who is connected and how (the connection's facts), or its call to pair. */
  private labelPill() {
    const r = this.remote
    const n = r.participants.length
    const who = n && r.participants.every((p) => p.paused) ? 'Phone paused' : n > 1 ? `${n} connected` : `Connected${r.deviceName ? ` to ${r.deviceName}` : ''}`
    const how = this.links.length ? `: ${this.factSentence()}` : ''
    const act = this.isOpen && this.pinned ? 'Close the pairing card' : 'Compare connection seal or pair another phone'
    this.$.pill.setAttribute('aria-label', n ? `${who}${how}. ${act}` : this.opts.label ?? 'Scan to control')
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
      if (changed && this.isOpen) box.animate?.([{ opacity: 0.7 }, { opacity: 1 }], { duration: 160 })
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
    this.$.qr.toggleAttribute('data-dense', url.length > 100)
    this.qr ??= import('./qr')
    void this.qr.then(({ brandedQrElement, plainQrElement, qrDotPoints }) => {
      if (this.drawn.url !== url || this.drawn.accent !== accent) return
      let svg: SVGSVGElement
      try { svg = brandedQrElement(url, { accent }) } catch { svg = plainQrElement(url) }
      // Dense capability links need three CSS pixels per module for the round
      // finders to survive rasterisation. The seal keeps this same footprint.
      const size = Math.max(168, Math.min(192, svg.viewBox.baseVal.width * 3))
      this.$.qr.style.setProperty('--obpal-qr-min', `${size}px`)
      this.surface.setQr(svg, qrDotPoints(url))
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
    document.addEventListener('transitionend', this.roomMotion, true)
    document.addEventListener('transitioncancel', this.roomMotion, true)
    this.checkRoom()
  }

  /** A transition can finish after its panel's state attribute already says shown. */
  private roomMotion = (e: Event) => {
    if (e.target instanceof Element && this.room?.seen.has(e.target)) this.queueRoom()
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
      // A fixed panel may move with its container's style without changing size.
      for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
        if (room.seen.has(node)) continue
        room.seen.add(node)
        room.mo.observe(node, { attributes: true })
        room.ro?.observe(node)
      }
    }
    // The card keeps its place while closed (it's only hidden), so this is where it opens.
    const element = this.$.card
    element.style.removeProperty('position'); element.style.removeProperty('left'); element.style.removeProperty('top')
    const card = element.getBoundingClientRect()
    // Shown is laid out and not hidden (a panel fading in counts from its first frame).
    const panels = els.filter(el => !el.contains(this.el) && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map(el => el.getBoundingClientRect())
    const meets = (left: number, top: number) => panels.some(r => Math.min(r.right, left + card.width) - Math.max(r.left, left) > 1 && Math.min(r.bottom, top + card.height) - Math.max(r.top, top) > 1)
    let blocked = meets(card.left, card.top)
    // A connected seal stays visible without covering approval, stop or camera controls. Move the same card to
    // a clear bottom corner; if the screen has no room, the compact chip remains available until a panel closes.
    if (blocked && this.remote.participants.length) {
      const margin = 16
      // Only the bottom corners: the top of a page holds its people chip and bars (the card must never sit on those), and
      // a card with no clear corner folds to the chip, whose compact seal stays in view.
      const bottom = innerHeight - card.height - 72
      const candidates = [[innerWidth - card.width - margin, bottom], [margin, bottom]]
      const clear = candidates.find(([left, top]) => left >= margin && top >= margin && top + card.height <= innerHeight - margin && !meets(left, top))
      if (clear) { element.style.position = 'fixed'; element.style.left = `${clear[0]}px`; element.style.top = `${clear[1]}px`; blocked = false }
    }
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
.chip-seal{display:inline-flex;align-items:center}.chip-seal[hidden]{display:none}
.scan-cues,.seals{font-size:11px;line-height:1.5}.scan-cues p,.seals p{margin:3px 0}.scan-cues{color:var(--ink);max-width:220px}.seals{display:none;max-height:50vh;overflow:auto}.seals>div{padding:8px 0}.seals b{font-size:12px}
.card[data-seal-view]>.qr,.card[data-seal-view]>.side{display:none}.card[data-seal-view]>.seals:not([hidden]){display:block}
.seal-view,.seal-back{min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:12px;background:rgb(var(--hl) / .05);color:var(--ink);font:inherit;cursor:pointer}.seal-view[hidden]{display:none}
.pair-icons{display:flex;gap:4px;color:var(--ink);align-items:center}.pair-icons .i{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6}.scan-cues summary{cursor:pointer;min-width:44px;min-height:44px;display:flex;align-items:center;font-size:20px}
.wrap[data-live] .pill>.conn,.wrap[data-live] .pill>.dot{display:none}.wrap[data-live] .side>.status{display:none}
.wrap[data-live] .label{display:none}
.card-x{display:none;position:absolute;top:-10px;right:-10px;width:44px;height:44px;margin:0;padding:0;border:0;background:none;color:var(--ink);cursor:pointer;place-items:center;touch-action:manipulation}
.card-x::before{content:'';grid-area:1/1;width:28px;height:28px;border-radius:50%;background:var(--glass);border:1px solid var(--line);box-shadow:var(--shadow)}
.card-x .i{grid-area:1/1;position:relative;width:14px;height:14px}
.card-x:hover::before{border-color:rgb(var(--a-rgb) / .55)}
.wrap[data-live]:not([data-variant=panel]) .card-x{display:grid}
.wrap[data-live] .side>.code-box,.wrap[data-live] .side>.here{display:none}
.card:not([data-seal-view]){flex-direction:column;align-items:center;gap:8px;width:220px}
.side{align-items:center;gap:4px;width:100%;min-height:48px}
.side>.status,.side>.seal-view{display:none}
.pair-icons{position:absolute;bottom:30px;left:18px}
.side>.seal-action{position:absolute;right:64px;bottom:18px}
.scan-cues{align-self:flex-end}.scan-cues[open]{align-self:stretch;background:var(--glass);z-index:3}
.scan-cues[open]~*{position:relative}
.scan-cues summary{justify-content:flex-end}
.facts .fact{font-size:0;padding:4px 6px;height:28px}.facts .fact .i{width:16px;height:16px}
.seal-view{font-size:0}.seal-view::after{content:'≋';font-size:20px}
.community-build{pointer-events:auto;color:var(--ink);font-size:11px;line-height:1.5;padding:6px 10px;border:1px solid var(--line);border-radius:10px;background:var(--glass)}

:host { display: contents; }
/* The shadow tree shares the interaction roles. An opaque backing keeps the ring legible on any host page. */
:focus:not(:focus-visible) { outline: none; }
.wrap :focus-visible { outline: var(--interaction-ring-width, 2px) solid var(--interaction-ring); outline-offset: var(--interaction-ring-offset, 3px); box-shadow: 0 0 0 8px var(--chip-focus-gap), var(--shadow); filter: drop-shadow(0 0 5px var(--interaction-glow, color-mix(in srgb, var(--a) 32%, transparent))); }
@media (hover: hover) { :is(button, a):hover:not(:focus-visible) { filter: drop-shadow(0 2px 5px var(--interaction-hover-glow, color-mix(in srgb, var(--a) 18%, transparent))); } }
@media (forced-colors: active) { .wrap :focus-visible { outline-color: Highlight; filter: none; } }
.wrap {
  --ox: var(--obpal-offset-x, var(--obpal-offset, 16px)); --oy: var(--obpal-offset-y, var(--obpal-offset, 16px)); --ease: cubic-bezier(.2, .8, .2, 1); --base: 18 20 26; --frost-alpha: 1;
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
  --interaction-ring: color-mix(in srgb, var(--a) 70%, #fff);
  --chip-focus-gap: #12141a;
  --glass: rgb(var(--base) / var(--frost-alpha)); --shadow: 0 18px 46px rgb(0 0 0 / .38), inset 0 1px 0 rgb(255 255 255 / .12); }
.wrap[data-scheme=light] { --ink: #14171c; --muted: rgb(20 23 28 / .62); --line: rgb(15 20 30 / .1); --hl: 0 0 0;
  --interaction-ring: color-mix(in srgb, var(--a) 45%, #14171c);
  --chip-focus-gap: #fff;
  --glass: rgb(255 255 255 / var(--frost-alpha)); --shadow: 0 16px 40px rgb(15 20 30 / .16), inset 0 1px 0 rgb(255 255 255 / .8); }
@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) { .wrap { --frost-alpha: .96; } }

/* Match the site's frost while respecting an explicitly chosen chip scheme. */
.pill, .card { background: var(--glass); border: 1px solid var(--line); box-shadow: var(--shadow);
  -webkit-backdrop-filter: var(--frost-blur, blur(28px) saturate(150%)); backdrop-filter: var(--frost-blur, blur(28px) saturate(150%)); }
/* Only the chip and the open card take the pointer (a closing card lets go at once): the page gets it everywhere else. */
.pill, .wrap[data-open] .card { pointer-events: auto; }

.pill { position: relative; display: inline-flex; align-items: center; gap: 9px; height: 44px; margin: 0; padding: 0 11px;
  border-radius: var(--pill-r, 999px); color: inherit; font: inherit; font-weight: 650; cursor: pointer; touch-action: manipulation;
  transition: border-color .2s var(--ease), transform .12s var(--ease), padding .24s var(--ease); }
.pill:hover { border-color: rgb(var(--a-rgb) / .55); }
.pill:active { transform: scale(.98); }

.wrap[data-open] .pill { border-color: rgb(var(--a-rgb) / .7); }
.mark { display: grid; place-items: center; width: 32px; height: 32px; flex: none; }
.mark svg { width: 32px; height: 32px; overflow: visible; display: block; }
.label { white-space: nowrap; }
.wrap[data-live]:not([data-open]) .label { display: none; }
.wrap[data-live]:not([data-open]) .pill { padding: 0 9px; }
.badge:empty { display: none; }
.badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center;
  background: rgb(var(--hl) / .12); font-variant-numeric: tabular-nums; }
.dot, .sdot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--muted); }
.wrap[data-s=ready] :is(.dot, .sdot) { background: var(--a); box-shadow: 0 0 0 3px rgb(var(--a-rgb) / .2); }
.wrap[data-s=connecting] :is(.dot, .sdot) { background: #fcd34d; }
.wrap[data-s=connected] :is(.dot, .sdot) { background: #6ee7b7; }
.wrap[data-s=offline] :is(.dot, .sdot) { background: #fb7185; }

.card { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; padding: 16px 18px 16px 16px; border-radius: var(--r, 18px); max-width: 460px;
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
.qr { width: max(var(--obpal-qr, 168px), var(--obpal-qr-min, 0px)); height: max(var(--obpal-qr, 168px), var(--obpal-qr-min, 0px)); flex: none; border-radius: 10px; background: #fff;
  box-shadow: 0 0 0 1.5px rgb(var(--a-rgb) / .55), 0 10px 30px rgb(var(--a-rgb) / .2); }
.qr svg { display: block; width: 100%; height: 100%; }
.qr[data-dense] { width: var(--obpal-qr, 192px); height: var(--obpal-qr, 192px); }
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
.here { border-radius: 3px; }
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
.facts { border-radius: 12px; }
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
