/**
 * Service worker side of the PC target: the Chrome Native Messaging port to ob.Pal Desktop (desktop/).
 *
 * - Connects when the target is PC (or an extension page asks, to edit the allowlist) and the optional
 *   `nativeMessaging` permission is granted; arms injection (`enable`) only while the target is PC.
 * - Forwards action frames from the offscreen link (already validated there, validated again here).
 * - Mirrors what the helper reports (hello, config, status) into storage.session "pc" for the popup and
 *   the options page, and turns their requests into helper requests.
 * The helper releases everything it holds when this port closes, so a dead service worker is safe.
 */
import type { TargetMode } from './shared/constants'
import {
  EMPTY_PC, NATIVE_HOST, NATIVE_PROTO, parseHelperMessage, toHelperRequest,
  type HelperRequest, type NativeFrame, type PcLink, type PcRequest, type PcState,
} from './shared/native'

export const NATIVE_PERMISSION: chrome.permissions.Permissions = { permissions: ['nativeMessaging'] }
const RETRY_MS = [1000, 3000, 10000, 30000]

export class NativeBridge {
  private port: chrome.runtime.Port | null = null
  private state: PcState = { ...EMPTY_PC }
  private ready = false
  private armed = false
  private wantMode = false
  private wantPage = false
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  /** Reconcile with the target mode: connect and arm for PC, disarm (and let go) otherwise. */
  async sync(mode: TargetMode) {
    this.wantMode = mode === 'pc'
    await this.reconcile()
  }

  /** An extension page wants the helper (to show or edit the allowlist) whatever the target is. */
  async request() {
    this.wantPage = true
    await this.reconcile()
  }

  /** An action frame from the offscreen link; dropped unless the helper is up and armed. */
  frame(f: NativeFrame) {
    if (this.ready && this.armed) this.send(f)
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
    if (!this.wantMode && !this.wantPage) return this.drop('off')
    if (!(await chrome.permissions.contains(NATIVE_PERMISSION))) return this.drop('permission')
    if (!this.port) this.connect()
    this.arm(this.wantMode)
  }

  private arm(on: boolean) {
    if (!this.ready || this.armed === on) return
    this.armed = on
    this.send({ t: 'enable', on })
  }

  private connect() {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
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
        this.set({ link: 'ready', version: m.version, hotkey: m.hotkey, error: null })
        this.arm(this.wantMode)
        break
      case 'config':
        this.set({ config: { paused: m.paused, programs: m.programs } })
        break
      case 'status':
        this.set({ status: { enabled: m.enabled, panic: m.panic, held: m.held, front: m.front, program: m.program } })
        break
      case 'error':
        console.warn(`[ob.Pal Link] helper: ${m.code}: ${m.msg}`)
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
    this.armed = false
    if (/not found/i.test(msg)) return this.set({ link: 'missing', error: null, status: null })
    if (/forbidden/i.test(msg)) return this.set({ link: 'error', error: 'This copy of ob.Pal Link is not allowed by the installed helper (its extension ID differs).', status: null })
    this.set({ link: 'error', error: msg || (wasReady ? 'The helper stopped.' : 'The helper did not answer.'), status: null })
    // It exited while wanted (a crash, or Windows killed it): come back, with backoff.
    if ((this.wantMode || this.wantPage) && this.retries < RETRY_MS.length) {
      this.retryTimer = setTimeout(() => void this.reconcile(), RETRY_MS[this.retries++])
    }
  }

  private drop(link: PcLink) {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const p = this.port
    this.port = null
    this.ready = false
    this.armed = false
    try { p?.disconnect() } catch { /* gone */ }
    this.set({ link, error: null, status: null })
  }

  private set(patch: Partial<PcState>) {
    this.state = { ...this.state, ...patch }
    void chrome.storage.session.set({ pc: this.state }).catch(() => undefined)
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
