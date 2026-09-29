/**
 * <obpal-remote>: ob.Pal in one tag (PLAN §10 step 3). It makes a Remote, shows the pairing chip in a corner, fires DOM
 * events as phones join, press and leave, and hands a page each frame's input for its own loop.
 *
 *   <script type="module" src="https://obpal.blackboxes.net/embed.js"></script>
 *   <obpal-remote app="My scene" modes="face.trackpad face.wii" seats="4"></obpal-remote>
 *
 * This part is small. The SDK, the room and the chip (./element-host) load on the first sign of a person (a pointer,
 * a key, a scroll or a touch), when the chip is opened, or when the page awaits `ready`. Everything it draws lives in
 * shadow roots, and it adds nothing to the page's own styles.
 */
import type { Caps, Layout, ModeId, SceneNode } from '@obpal/core'
import type { ElementHost } from './element-host'
import type { Frame, HostStatus, Participant, Remote } from './remote'

type HostModule = typeof import('./element-host')

/** idle: not started yet. unsupported: this browser can't host a phone (no WebRTC, or not a secure page). error: it couldn't start. */
export type ObpalRemoteStatus = 'idle' | HostStatus | 'unsupported' | 'error'

/** The element's DOM events (they bubble). Every Remote event but `input` and `lan` is one, with the participant. */
export interface ObpalRemoteEventMap {
  'obpal-status': CustomEvent<{ status: ObpalRemoteStatus; reason?: string }>
  /** A phone connected to an empty scene (with one seat: every phone that takes over). */
  'obpal-connect': CustomEvent<{ name: string; caps: Caps }>
  /** The last phone left. */
  'obpal-disconnect': CustomEvent<Record<string, never>>
  'obpal-join': CustomEvent<{ participant: Participant }>
  'obpal-leave': CustomEvent<{ participant: Participant }>
  /** Tray buttons, trackpad taps (id `pad`), the Wii face (wii-a, wii-b, …) and the key row (key-Enter, …). */
  'obpal-button': CustomEvent<{ id: string; ev: string; participant: Participant }>
  'obpal-text': CustomEvent<{ s: string; del: number; participant: Participant }>
  'obpal-toss': CustomEvent<{ v: number; participant: Participant }>
  'obpal-value': CustomEvent<{ id: string; v: number | boolean | string; add?: boolean; participant: Participant }>
  /** A phone switched mode or controller (CATALOGUE §9.4). */
  'obpal-mode': CustomEvent<{ mode: ModeId; controller?: string; profile?: string; participant: Participant }>
  'obpal-recenter': CustomEvent<{ participant: Participant }>
  'obpal-pad': CustomEvent<{ connected: boolean; participant: Participant }>
  /** A phone asks for a node (null: to let go). Cancel it to refuse, or to keep the claims yourself with setScene({ held }). */
  'obpal-claim': CustomEvent<{ node: string | null; participant: Participant }>
}

const ATTRS = ['app', 'modes', 'seats', 'profile', 'corner', 'accent', 'open', 'label', 'scheme', 'code', 'test-link', 'service']
/** Attributes the chip is drawn from; changing one redraws it. */
const CHIP_ATTRS = new Set(['corner', 'accent', 'label', 'scheme', 'code', 'test-link'])
/** What counts as a person being here. */
const PRESENCE = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

const CSS = ':host{display:contents}:host([corner=inline]){display:inline-block;vertical-align:middle}:host([hidden]){display:none!important}.retry{position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 14px;border:0;border-radius:8px;background:#c6ff34;color:#172009;font:600 14px system-ui;cursor:pointer}:host([corner=inline]) .retry{position:static}'

/**
 * The element's own styles, in its shadow root: a constructed stylesheet shared by every instance (a Content Security
 * Policy without 'unsafe-inline' allows it), or a <style> where there are none (Safari before 16.4).
 */
let sheet: CSSStyleSheet | null = null
function style(root: ShadowRoot) {
  if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
    if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS) }
    root.adoptedStyleSheets = [sheet]
    return
  }
  const s = document.createElement('style')
  s.textContent = CSS
  root.appendChild(s)
}

/** A frame with nothing in it: before the element starts, and where it can't. */
const idleFrame = (): Frame => ({
  connected: false, mode: 0, tier: 0, clutch: false, grab: 0, qRel: [0, 0, 0, 1], touching: false,
  aim: [0, 0], tilt: [0, 0], pad1: [0, 0], pad2: [0, 0], zoom: 0, twist: 0, pose: null, hand: null, body: null,
})

/** Where remotes pair unless an element's `service` says otherwise (the hosted script sets its own origin). */
let serviceDefault: string | undefined
let loadHost: () => Promise<HostModule> = () => import('./element-host')

// Server-side rendering has no HTMLElement: the class still loads there, and is defined only in a browser.
const Base = (typeof HTMLElement === 'undefined' ? class {} : HTMLElement) as typeof HTMLElement

export class ObpalRemote extends Base {
  static get observedAttributes() { return ATTRS }

  private host: ElementHost | null = null
  private mod: HostModule | null = null
  private starting: Promise<Remote | null> | null = null
  /** Bumped on teardown, so a start still loading when the element leaves the page stops there. */
  private gen = 0
  private statusNow: ObpalRemoteStatus = 'idle'
  private extra: Partial<Layout> = {}
  private scene: { nodes?: SceneNode[]; held?: Record<string, string> } | null = null
  private present: (() => void) | null = null
  private retry: HTMLButtonElement | null = null

  constructor() {
    super()
    style(this.attachShadow({ mode: 'open' }))
  }

  /** The Remote, once started; null before, and where it can't start. */
  get remote(): Remote | null { return this.host?.remote ?? null }
  /** The Remote once it has started (awaiting this starts it now), or null where this browser can't host a phone. */
  get ready(): Promise<Remote | null> { return this.start() }
  get status(): ObpalRemoteStatus { return this.statusNow }
  /** Everyone controlling the scene, the lead first. */
  get participants(): Participant[] { return this.host?.remote.participants ?? [] }
  /** The link the chip's code holds (empty until started). */
  get pairingUrl(): string { return this.host?.remote.pairingUrl ?? '' }
  /** The chip is open, showing the code (the `open` attribute). */
  get open(): boolean { return this.hasAttribute('open') }
  set open(v: boolean) { this.toggleAttribute('open', !!v) }
  /**
   * Layout fields beside the attributes' modes and profile (PROTOCOL §3): `tray` buttons, hardware `keys`, `toss`,
   * `point`, `wheel`, `utilities`. Where both say something, this wins.
   */
  get layout(): Partial<Layout> { return this.extra }
  set layout(v: Partial<Layout>) {
    this.extra = { ...v }
    if (this.host && this.mod) this.host.setLayout(this.layoutFrom(this.mod))
  }

  /** Start now instead of on the first sign of a person. Resolves as `ready` does. */
  start(): Promise<Remote | null> {
    this.starting ??= this.boot(this.gen)
    return this.starting
  }

  /**
   * This frame's input: the lead's, or one participant's in a shared scene. Deltas are since the last call for the
   * same participant, so call it once per rendered frame for each.
   */
  frame(now = performance.now(), who?: string): Frame {
    return this.host?.frame(now, who) ?? idleFrame()
  }

  /**
   * What phones may take over (seats > 1), and who holds what. Without `held` the element keeps the claims itself:
   * one participant per node, first come; `held` makes the table exactly that (node id → participant id, `host` for
   * the page). Before the element starts, the latest scene waits for it.
   */
  setScene(s: { nodes?: SceneNode[]; held?: Record<string, string> }) {
    if (this.host) this.host.setScene(s)
    else this.scene = { nodes: s.nodes ?? this.scene?.nodes, held: s.held ?? this.scene?.held }
  }

  /** Who controls a node: its holder, or whoever holds the node it is part of. Null when nobody does. */
  holder(node: string): string | null { return this.host?.holder(node) ?? null }
  /** The node a participant holds, or null. */
  holding(who: string): string | null { return this.host?.holding(who) ?? null }
  /** Who holds what (node id → participant id), to build on: `setScene({ held: { ...el.held, cube: id } })`. */
  get held(): Record<string, string> { return this.host?.held() ?? { ...(this.scene?.held ?? {}) } }

  connectedCallback() {
    if (this.host || this.starting) return
    if (this.hasAttribute('open')) void this.start()
    else this.waitForPresence()
  }

  disconnectedCallback() {
    this.stopWaiting()
    // Moved rather than removed: it is back in the page before this runs, and keeps its remote.
    queueMicrotask(() => { if (!this.isConnected) this.teardown() })
  }

  attributeChangedCallback(name: string, before: string | null, value: string | null) {
    if (before === value) return
    if (name === 'open' && value !== null && !this.starting && this.isConnected) { void this.start(); return }
    const h = this.host
    const mod = this.mod
    if (!h || !mod) return
    if (name === 'open') h.expand(value !== null)
    else if (name === 'modes' || name === 'profile') h.setLayout(this.layoutFrom(mod))
    else if (CHIP_ATTRS.has(name)) h.setChip(this.chipFrom(mod))
    // app, seats and service take effect when the element starts.
  }

  private fire(name: string, detail: object, cancelable = false): boolean {
    return this.dispatchEvent(new CustomEvent(`obpal-${name}`, { detail, bubbles: true, cancelable }))
  }

  private setStatus(s: ObpalRemoteStatus, reason?: string) {
    if (s === this.statusNow) return
    this.statusNow = s
    this.fire('status', reason ? { status: s, reason } : { status: s })
  }

  private waitForPresence() {
    if (this.present) return
    const go = () => void this.start()
    for (const e of PRESENCE) addEventListener(e, go, { passive: true, capture: true })
    this.present = () => { for (const e of PRESENCE) removeEventListener(e, go, { capture: true }) }
  }

  private stopWaiting() {
    this.present?.()
    this.present = null
  }

  private async boot(gen: number): Promise<Remote | null> {
    this.stopWaiting()
    this.retry?.remove()
    this.retry = null
    this.setStatus('starting')
    try {
      const mod = await loadHost()
      if (gen !== this.gen) return null
      this.mod = mod
      const r = await mod.startHost({
        appName: this.getAttribute('app')?.trim() || document.title.trim() || location.hostname || 'This page',
        service: this.getAttribute('service')?.trim() || serviceDefault,
        seats: mod.parseSeats(this.getAttribute('seats')),
        layout: this.layoutFrom(mod),
        chip: this.chipFrom(mod),
        emit: (name, detail, cancelable) => this.fire(name, detail, cancelable),
        status: (s) => this.setStatus(s),
        toggled: (open) => { if (open !== this.open) this.open = open },
      })
      if ('unsupported' in r) {
        if (gen !== this.gen) return null
        console.warn(`<obpal-remote>: no phone can pair here: ${r.unsupported}.`)
        this.setStatus('unsupported', r.unsupported)
        return null
      }
      if (gen !== this.gen) { r.host.destroy(); return null }
      this.host = r.host
      if (this.scene) { r.host.setScene(this.scene); this.scene = null }
      this.setStatus(r.host.remote.status)
      return r.host.remote
    } catch (e) {
      if (gen !== this.gen) return null
      console.warn('<obpal-remote>: it could not start.', e)
      this.setStatus('error', String((e as Error)?.message ?? e))
      const retry = document.createElement('button')
      retry.className = 'retry'
      retry.type = 'button'
      retry.textContent = 'Retry ob.Pal'
      retry.addEventListener('click', () => { this.starting = null; void this.start() })
      this.shadowRoot!.appendChild(retry)
      this.retry = retry
      return null
    }
  }

  private teardown() {
    this.gen++
    this.retry?.remove()
    this.retry = null
    this.host?.destroy()
    this.host = null
    this.starting = null
    this.setStatus('idle')
  }

  private layoutFrom(mod: HostModule): Layout {
    return mod.embedLayout({ modes: this.getAttribute('modes'), profile: this.getAttribute('profile') }, this.extra)
  }

  private chipFrom(mod: HostModule) {
    const accent = this.getAttribute('accent')?.trim()
    const label = this.getAttribute('label')?.trim()
    return {
      corner: mod.parseCorner(this.getAttribute('corner')),
      scheme: mod.parseScheme(this.getAttribute('scheme')),
      open: this.hasAttribute('open'),
      code: mod.parseFlag(this.getAttribute('code'), true),
      testLink: mod.parseFlag(this.getAttribute('test-link'), false),
      parent: this.shadowRoot!,
      ...(accent ? { accent } : {}),
      ...(label ? { label } : {}),
    }
  }
}

export interface ObpalRemote {
  addEventListener<K extends keyof ObpalRemoteEventMap>(type: K, listener: (this: ObpalRemote, ev: ObpalRemoteEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void
  addEventListener<K extends keyof HTMLElementEventMap>(type: K, listener: (this: ObpalRemote, ev: HTMLElementEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void
  removeEventListener<K extends keyof ObpalRemoteEventMap>(type: K, listener: (this: ObpalRemote, ev: ObpalRemoteEventMap[K]) => unknown, options?: boolean | EventListenerOptions): void
  removeEventListener<K extends keyof HTMLElementEventMap>(type: K, listener: (this: ObpalRemote, ev: HTMLElementEventMap[K]) => unknown, options?: boolean | EventListenerOptions): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void
}

declare global {
  interface HTMLElementTagNameMap { 'obpal-remote': ObpalRemote }
}

/**
 * Define <obpal-remote> (once: a second copy of the script leaves the first in place). `service`: the room service
 * its remotes pair through unless an element's own `service` attribute says otherwise.
 */
export function defineObpalRemote(o: { service?: string; loadHost?: () => Promise<HostModule> } = {}) {
  if (o.service) serviceDefault = o.service
  if (o.loadHost) loadHost = o.loadHost
  if (typeof customElements !== 'undefined' && !customElements.get('obpal-remote')) customElements.define('obpal-remote', ObpalRemote)
}
