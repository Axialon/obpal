/**
 * Service worker side of the PC target: the Chrome Native Messaging port to ob.Pal Desktop (desktop/).
 *
 * - Connects when the target is PC (or while an extension page that shows the helper is open, to edit the
 *   allowlist) and the optional `nativeMessaging` permission is granted; arms injection (`enable`) only while
 *   the target is PC and the phone connected is one the person at the PC allowed (shared/access.ts), and only once
 *   the offscreen link has the gamepad mapping for what the helper's config says (the whole PC or one program).
 *   Otherwise the helper is closed, so it isn't left running (and its file locked) for nothing.
 * - Forwards action frames and typing from the offscreen link (already validated there, validated again here).
 * - Mirrors what the helper reports (hello, config, status) into storage.session "pc" for the popup and
 *   the options page, and turns their requests into helper requests. A worker that starts again (it idled out)
 *   picks the helper's config back up from there, so it knows at once whether the whole PC is controlled.
 * - Tells the offscreen link when a text field in front would take typing (so the phone offers its keyboard), and
 *   when typing didn't get through.
 * The helper releases everything it holds when this port closes, so a dead service worker is safe.
 */
import type { TargetMode } from './shared/constants'
import {
  EMPTY_PC, isTypingRefusal, NATIVE_HOST, NATIVE_PROTO, parseHelperMessage, parsePcState, toHelperRequest, typingField,
  type HelperRequest, type NativeFrame, type NativeText, type PcLink, type PcRequest, type PcState, type TextField, type TypingRefusal,
} from './shared/native'

export const NATIVE_PERMISSION: chrome.permissions.Permissions = { permissions: ['nativeMessaging'] }
const RETRY_MS = [1000, 3000, 10000, 30000]

export class NativeBridge {
  private port: chrome.runtime.Port | null = null
  private state: PcState = { ...EMPTY_PC }
  private ready = false
  /** This connection's first config is through: handled, and passed on to the offscreen link if it changed whole PC. */
  private configured = false
  private armed = false
  private wantMode = false
  /** The phone connected now may control this PC: the person at the PC said so (shared/access.ts). */
  private allowed = false
  /** Extension pages holding a PC_PAGE_PORT_NAME port. */
  private pages = 0
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  /** The helper types (0.3 and later). */
  private textCap = false
  private field: TextField | null = null
  /**
   * The helper's config as this worker's previous run mirrored it (storage.session "pc"), picked back up when the
   * worker starts again. Everything that reads whole PC or changes the state waits for it.
   */
  private restored: Promise<void> = chrome.storage.session.get('pc').then((r) => {
    const config = parsePcState(r.pc)?.config
    if (config) this.state = { ...this.state, config }
  }, () => {})
  /** Called when whole-PC control turns on or off; the helper is armed once what it returns has settled. */
  onDesktop: ((on: boolean) => unknown) | null = null
  /** Called when the field that would take typing changes (null: none). */
  onTextField: ((field: TextField | null) => void) | null = null
  /** Called when typing from the phone didn't get through. */
  onTyping: ((refused: TypingRefusal) => void) | null = null

  /** ob.Pal Desktop controls the whole PC (not one program). */
  get desktop(): boolean {
    return !!this.state.config?.desktop
  }

  /** Whether ob.Pal Desktop controls the whole PC, as it last said (before this worker started, if not since). */
  async wholePc(): Promise<boolean> {
    await this.restored
    return this.desktop
  }

  /** A text or password field in front would take typing now (see typingField). */
  get textField(): TextField | null {
    return this.field
  }

  /**
   * Reconcile with the target mode and the phone: connect for PC, and arm only while a phone the person at the PC
   * allowed is connected; disarm (and let go) otherwise.
   */
  async sync(mode: TargetMode, allowed: boolean) {
    this.wantMode = mode === 'pc'
    this.allowed = allowed
    await this.reconcile()
  }

  /** Connect now if the helper is wanted (a Retry, or a page that just opened). */
  async request() {
    this.retries = 0
    await this.reconcile()
  }

  /** An extension page shows the helper's state (the allowlist) whatever the target is: keep it up while it is open. */
  pageOpened() {
    this.pages++
    void this.reconcile()
  }

  pageClosed() {
    this.pages = Math.max(0, this.pages - 1)
    void this.reconcile()
  }

  /** An action frame from the offscreen link; dropped unless the helper is up and armed. */
  frame(f: NativeFrame) {
    if (this.ready && this.armed) this.send(f)
  }

  /** Typing from the phone, through the offscreen link: to a helper that is up, armed and types; otherwise the phone hears why not. */
  text(t: NativeText) {
    if (!this.ready || !this.armed) this.onTyping?.('offline')
    else if (!this.textCap) this.onTyping?.('no-text')
    else this.send(t)
  }

  /** Popup and options page requests. */
  async handle(req: PcRequest): Promise<{ ok: boolean; error?: string }> {
    if (req.type === 'pc-connect') {
      await this.request()
      return { ok: true }
    }
    if (!this.ready) return { ok: false, error: 'helper not connected' }
    const m = toHelperRequest(req)
    return m && this.send(m) ? { ok: true } : { ok: false, error: 'helper not connected' }
  }

  private async reconcile() {
    await this.restored
    if (!this.wantMode && !this.pages) return this.drop('off')
    if (!(await chrome.permissions.contains(NATIVE_PERMISSION))) return this.drop('permission')
    if (!this.port) this.connect()
    this.arm(this.wantMode && this.allowed)
  }

  private arm(on: boolean) {
    if (!this.ready || !this.configured || this.armed === on) return
    this.armed = on
    this.send({ t: 'enable', on })
  }

  private connect() {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.configured = false
    this.set({ link: 'connecting', error: null })
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST)
    } catch (e) {
      this.set({ link: 'error', error: e instanceof Error ? e.message : String(e), status: null })
      return
    }
    this.port = port
    port.onMessage.addListener((raw: unknown) => this.onMessage(port, raw))
    port.onDisconnect.addListener(() => this.onDisconnect(port))
    this.send({ t: 'hello', v: NATIVE_PROTO })
  }

  private onMessage(port: chrome.runtime.Port, raw: unknown) {
    if (port !== this.port) return
    const m = parseHelperMessage(raw)
    if (!m) return
    switch (m.t) {
      case 'hello':
        this.ready = true
        this.retries = 0
        this.textCap = m.caps.text
        this.set({ link: 'ready', version: m.version, desktopCap: m.caps.desktop, hotkey: m.hotkey, error: null })
        // Armed once its config (every helper sends it right after hello) is through: see 'config'.
        break
      case 'config': {
        const was = this.desktop
        this.set({ config: { paused: m.paused, desktop: m.desktop, programs: m.programs } })
        // Whole PC on or off: the offscreen link switches the gamepad's mapping. A connection is armed only once its
        // first config is through, so no frame mapped for the other kind of control (the game keys on a whole PC,
        // which would type letters into whatever has the focus) reaches the helper.
        const passed = this.desktop !== was ? this.onDesktop?.(this.desktop) : undefined
        const through = () => {
          if (port !== this.port) return
          this.configured = true
          this.arm(this.wantMode && this.allowed)
        }
        void Promise.resolve(passed).then(through, through)
        break
      }
      case 'status':
        this.set({ status: { enabled: m.enabled, panic: m.panic, held: m.held, front: m.front, program: m.program, text: m.text } })
        break
      case 'error':
        console.warn(`[ob.Pal Link] helper: ${m.code}: ${m.msg}`)
        if (isTypingRefusal(m.code)) this.onTyping?.(m.code)
        break
      case 'stats':
        this.set({ stats: { frames: m.frames, injected: m.injected, refused: m.refused } })
        break
    }
  }

  private onDisconnect(port: chrome.runtime.Port) {
    const msg = chrome.runtime.lastError?.message ?? ''
    if (port !== this.port) return
    const wasReady = this.ready
    this.port = null
    this.ready = false
    this.configured = false
    this.armed = false
    this.textCap = false
    if (/not found/i.test(msg)) return this.set({ link: 'missing', error: null, status: null })
    if (/forbidden/i.test(msg)) return this.set({ link: 'error', error: 'This copy of ob.Pal Link is not allowed by the installed helper (its extension ID differs).', status: null })
    this.set({ link: 'error', error: msg || (wasReady ? 'The helper stopped.' : 'The helper did not answer.'), status: null })
    // It exited while wanted (a crash, or Windows killed it): come back, with backoff.
    if ((this.wantMode || this.pages) && this.retries < RETRY_MS.length) {
      this.retryTimer = setTimeout(() => void this.reconcile(), RETRY_MS[this.retries++])
    }
  }

  private drop(link: PcLink) {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const p = this.port
    this.port = null
    this.ready = false
    this.configured = false
    this.armed = false
    this.textCap = false
    try { p?.disconnect() } catch { /* gone */ }
    this.set({ link, error: null, status: null })
  }

  private set(patch: Partial<PcState>) {
    this.state = { ...this.state, ...patch }
    void chrome.storage.session.set({ pc: this.state }).catch(() => undefined)
    const field = typingField(this.state)
    if (field !== this.field) {
      this.field = field
      this.onTextField?.(field)
    }
  }

  private send(m: HelperRequest): boolean {
    const p = this.port
    if (!p) return false
    try {
      p.postMessage(m)
      return true
    } catch {
      return false
    }
  }
}
