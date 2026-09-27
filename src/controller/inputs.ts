/**
 * The phone's physical inputs as one stream (spec/RESEARCH-BUTTONS.md), each an input id going down and up
 * (packages/core/src/buttons.ts):
 *  - keys: keyboards, presentation clickers, remotes, a selfie remote's Enter. The volume keys only come from a keyboard
 *    that has them: a phone's own volume and side keys never reach a browser page;
 *  - headset and earbud buttons through Media Session (one, two and three presses). An opt-in: it plays a silent
 *    track, which takes the audio focus and pauses the person's music;
 *  - pads through the Gamepad API, read from the start: until a page reads them, Chrome on Android gives a pad's
 *    buttons to its own shortcuts, where B closes the tab;
 *  - Back through CloseWatcher, an opt-in, caught once per touch, so two Backs in a row always leave.
 * What an input presses is the controller's business (./buttons.ts).
 */
import { keyInput, mediaInput, padAxis, padButton, type InputSource } from '@obpal/core'

export type HeadsetState = 'off' | 'on' | 'paused' | 'failed'
export interface PadInfo { index: number; name: string; standard: boolean }

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}
const SEEN_KEY = 'obpal.buttons-seen'
const MAX_SEEN = 80
/** Past this, an axis is pushed that way; back under the lower mark, it's let go. */
const AXIS_ON = 0.6
const AXIS_OFF = 0.3
/** Media Session actions a headset, an earbud or a keyboard's media keys can send (the lock-screen card too). */
const MEDIA_ACTIONS = ['play', 'pause', 'nexttrack', 'previoustrack', 'seekforward', 'seekbackward', 'stop'] as const
/**
 * Chrome on Android lays out a pad it doesn't know in the standard order anyway (only `mapping` is empty), so there its
 * buttons are named by the standard mapping too; elsewhere an unmapped pad's are raw.
 */
const androidChromium = /Android/.test(navigator.userAgent) && /Chrome\//.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent)

interface Watcher { onclose: (() => void) | null; destroy(): void }
const Watchers = (window as Window & { CloseWatcher?: new () => Watcher }).CloseWatcher

export class PhysicalInputs {
  /** An input went down or up. Return true when it did something, so a key's own default (scrolling) is stopped. */
  onInput?: (id: string, down: boolean) => boolean
  /** The headset's state, the pads connected, or Back's arming changed. */
  onChange?: () => void
  /** While set (the Buttons sheet is listening), handled keys go no further: Esc binds rather than closing the sheet. */
  capture = false
  /** Inputs that have reached this page on this phone, ever: a control shows a badge only for these. */
  readonly seen = new Set<string>()
  headset: HeadsetState = 'off'
  /** Back can be caught here (CloseWatcher: Chrome 126, Firefox 149). */
  readonly backAvailable = !!Watchers
  private keysDown = new Map<string, boolean>()
  private audio: HTMLAudioElement | null = null
  private pausing = false
  private pads = new Map<number, { name: string; standard: boolean; pressed: boolean[]; dirs: number[] }>()
  private polling = 0
  private watcher: Watcher | null = null
  private backWanted = false
  private rearmOnTouch = false

  constructor() {
    try { for (const id of JSON.parse(store.get(SEEN_KEY) ?? '[]') as unknown[]) if (typeof id === 'string') this.seen.add(id) } catch { /* none yet */ }
    addEventListener('keydown', (e) => this.key(e, true), { capture: true })
    addEventListener('keyup', (e) => this.key(e, false), { capture: true })
    addEventListener('blur', () => this.releaseKeys())
    addEventListener('gamepadconnected', (e) => { this.addPad(e.gamepad); this.poll() })
    addEventListener('gamepaddisconnected', (e) => this.dropPad(e.gamepad.index))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { this.releaseKeys(); this.releasePads() } else this.poll()
    })
    // A touch is what lets a page catch Back again (a user activation): re-arm on the touch's end, where it counts.
    addEventListener('pointerup', () => { if (this.rearmOnTouch && this.backWanted) { this.rearmOnTouch = false; this.armBack() } }, { capture: true })
    // Reading the pads from the start (the listener above counts too): Chrome on Android then hands their buttons to
    // the page instead of its own shortcuts.
    try { navigator.getGamepads?.() } catch { /* not allowed here */ }
  }

  // ---- keys ----

  private key(e: KeyboardEvent, down: boolean) {
    const id = keyInput(e)
    const volume = id.startsWith('key:AudioVolume')
    const t = e.target as HTMLElement | null
    // A text field's keys are its own; a checkbox or a button with the focus doesn't make the phone type.
    const typing = !!t && ((t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/.test((t as HTMLInputElement).type)) || t.tagName === 'TEXTAREA' || t.isContentEditable)
    // Typing belongs to the field; a shortcut (Ctrl, Alt or Cmd held) to the browser.
    if ((typing && !volume) || e.ctrlKey || e.altKey || e.metaKey) return
    if (down) {
      if (e.repeat || this.keysDown.has(id)) { if (this.keysDown.get(id)) this.stop(e); return }
      const handled = this.emit(id, true)
      this.keysDown.set(id, handled)
      if (handled) this.stop(e)
      return
    }
    if (!this.keysDown.has(id)) return
    const handled = this.keysDown.get(id)!
    this.keysDown.delete(id)
    this.emit(id, false)
    if (handled) this.stop(e)
  }

  private stop(e: KeyboardEvent) {
    e.preventDefault()
    if (this.capture) e.stopImmediatePropagation()
  }

  private releaseKeys() {
    for (const id of [...this.keysDown.keys()]) { this.keysDown.delete(id); this.emit(id, false) }
  }

  private emit(id: string, down: boolean): boolean {
    if (down && !this.seen.has(id)) {
      this.seen.add(id)
      const all = [...this.seen]
      store.set(SEEN_KEY, JSON.stringify(all.slice(-MAX_SEEN)))
    }
    return this.onInput?.(id, down) ?? false
  }

  /** One event with no release (a headset press, Back): down, then up at once. */
  private tap(id: string) {
    this.emit(id, true)
    this.emit(id, false)
  }

  // ---- headset and earbud buttons ----

  /** Headset buttons: hold a media session with a silent track. Call from a tap (autoplay rules). */
  async enableHeadset(title: string): Promise<boolean> {
    if (!('mediaSession' in navigator)) { this.setHeadset('failed'); return false }
    if (!this.audio) {
      this.audio = new Audio(silentWav())
      this.audio.loop = true
      // The phone paused it (headphones out, a call, another app's music): the session is gone until a tap.
      this.audio.addEventListener('pause', () => { if (!this.pausing && this.headset === 'on') this.setHeadset('paused') })
    }
    try { await this.audio.play() } catch { this.setHeadset('failed'); return false }
    const session = navigator.mediaSession
    try { session.metadata = new MediaMetadata({ title, artist: 'ob.Pal controller', artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] }) } catch { /* no metadata */ }
    for (const action of MEDIA_ACTIONS) {
      try {
        session.setActionHandler(action as MediaSessionAction, () => {
          this.tap(mediaInput(action))
          // A press pauses the track: keep it going, so the session (and the next press) stays with the controller.
          void this.audio?.play().catch(() => {})
          session.playbackState = 'playing'
        })
      } catch { /* not an action here */ }
    }
    session.playbackState = 'playing'
    this.setHeadset('on')
    return true
  }

  disableHeadset() {
    this.pausing = true
    this.audio?.pause()
    this.pausing = false
    if ('mediaSession' in navigator) {
      for (const action of MEDIA_ACTIONS) { try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, null) } catch { /* not an action here */ } }
      navigator.mediaSession.playbackState = 'none'
    }
    this.setHeadset('off')
  }

  private setHeadset(s: HeadsetState) {
    if (s === this.headset) return
    this.headset = s
    this.onChange?.()
  }

  // ---- pads ----

  /** The pads connected now (each shows itself only after a button press). */
  padList(): PadInfo[] {
    return [...this.pads.entries()].map(([index, p]) => ({ index, name: p.name, standard: p.standard }))
  }

  private addPad(gp: Gamepad) {
    if (this.pads.has(gp.index)) return
    const standard = gp.mapping === 'standard' || (androidChromium && gp.mapping === '')
    this.pads.set(gp.index, { name: padLabel(gp.id), standard, pressed: gp.buttons.map(() => false), dirs: gp.axes.map(() => 0) })
    this.onChange?.()
  }

  private dropPad(index: number) {
    const p = this.pads.get(index)
    if (!p) return
    this.releasePad(p)
    this.pads.delete(index)
    this.onChange?.()
  }

  private releasePad(p: { standard: boolean; pressed: boolean[]; dirs: number[] }) {
    p.pressed.forEach((on, i) => { if (on) { p.pressed[i] = false; this.emit(padButton(i, p.standard), false) } })
    p.dirs.forEach((d, i) => { if (d) { p.dirs[i] = 0; this.emit(padAxis(i, d as 1 | -1, p.standard), false) } })
  }

  private releasePads() { for (const p of this.pads.values()) this.releasePad(p) }

  /** Read the pads every frame while any is connected and the page is visible. */
  private poll() {
    if (this.polling || !this.pads.size || document.visibilityState !== 'visible') return
    const frame = () => {
      this.polling = 0
      if (!this.pads.size || document.visibilityState !== 'visible') return
      let list: (Gamepad | null)[] = []
      try { list = [...(navigator.getGamepads?.() ?? [])] } catch { /* not allowed */ }
      for (const gp of list) {
        if (!gp) continue
        if (!this.pads.has(gp.index)) this.addPad(gp)
        const p = this.pads.get(gp.index)!
        gp.buttons.forEach((b, i) => {
          if (b.pressed === !!p.pressed[i]) return
          p.pressed[i] = b.pressed
          this.emit(padButton(i, p.standard), b.pressed)
        })
        gp.axes.forEach((a, i) => {
          const dir = a > AXIS_ON ? 1 : a < -AXIS_ON ? -1 : Math.abs(a) < AXIS_OFF ? 0 : p.dirs[i] ?? 0
          const was = p.dirs[i] ?? 0
          if (dir === was) return
          p.dirs[i] = dir
          if (was) this.emit(padAxis(i, was as 1 | -1, p.standard), false)
          if (dir) this.emit(padAxis(i, dir as 1 | -1, p.standard), true)
        })
      }
      this.polling = requestAnimationFrame(frame)
    }
    this.polling = requestAnimationFrame(frame)
  }

  // ---- Back ----

  /** Whether Back is armed right now (the next Back is the controller's, not the browser's). */
  get backArmed() { return !!this.watcher }

  /**
   * Catch Back, or stop. Armed from a tap, it catches one Back; it arms again only after the next touch, so two Backs
   * in a row always leave, whatever the browser would allow.
   */
  wantBack(on: boolean) {
    if (on === this.backWanted) return
    this.backWanted = on
    this.rearmOnTouch = false
    if (on) this.armBack()
    else { this.watcher?.destroy(); this.watcher = null; this.onChange?.() }
  }

  private armBack() {
    if (!Watchers || this.watcher) return
    try {
      const w = new Watchers()
      w.onclose = () => {
        if (this.watcher !== w) return
        this.watcher = null
        this.rearmOnTouch = true
        this.tap('back')
        this.onChange?.()
      }
      this.watcher = w
      this.onChange?.()
    } catch { /* not now */ }
  }
}

/** A pad's name without the browser's decoration: "Xbox Wireless Controller", not "(STANDARD GAMEPAD Vendor: …)". */
export function padLabel(id: string): string {
  return id.replace(/\s*\((?:STANDARD GAMEPAD\s*)?(?:Vendor: [0-9a-f]{4} Product: [0-9a-f]{4})?\)\s*$/i, '').replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '').trim() || 'Pad'
}

/** Which source an input belongs to, as the Buttons sheet groups them (a keyboard's volume keys are keys). */
export const groupOf = (source: InputSource): 'keys' | 'media' | 'pad' | 'back' => (source === 'volume' ? 'keys' : source)

/**
 * Ten seconds of 8 kHz 8-bit silence as a WAV blob URL. Longer than 5 s on purpose: Chromium treats shorter media as
 * transient, which gets no media session on Android, so the headset's presses would go to the last music app instead
 * (spec/RESEARCH-BUTTONS.md).
 */
function silentWav(): string {
  const n = 8000 * 10
  const b = new Uint8Array(44 + n)
  const v = new DataView(b.buffer)
  const s = (o: number, t: string) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i) }
  s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVE'); s(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true)
  v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, 'data'); v.setUint32(40, n, true)
  b.fill(128, 44)
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }))
}
