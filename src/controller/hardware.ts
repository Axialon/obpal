/**
 * Hardware buttons a phone can lend the controller, wherever the browser allows:
 *  - volume keys, when the browser passes them to the page (some Android browsers do; iOS keeps them);
 *  - keys from a Bluetooth keyboard, remote or presentation clicker (Enter, Space, Escape, arrows, Page Up/Down);
 *  - headset and earbud buttons (play/pause, next, previous) through Media Session. That needs a silent track
 *    playing, which takes the audio focus, so it's an opt-in.
 * Each becomes an action: primary, secondary, next or previous. The controller decides what they do in each mode.
 */
export type HwAction = 'primary' | 'secondary' | 'next' | 'prev'
export type HwSource = 'volume' | 'keys' | 'headset'

const BY_KEY: Record<string, [HwAction, HwSource]> = {
  AudioVolumeUp: ['primary', 'volume'], VolumeUp: ['primary', 'volume'],
  AudioVolumeDown: ['secondary', 'volume'], VolumeDown: ['secondary', 'volume'],
  Enter: ['primary', 'keys'], ' ': ['primary', 'keys'], MediaPlayPause: ['primary', 'keys'],
  Escape: ['secondary', 'keys'], Backspace: ['secondary', 'keys'],
  PageDown: ['next', 'keys'], ArrowRight: ['next', 'keys'], MediaTrackNext: ['next', 'keys'],
  PageUp: ['prev', 'keys'], ArrowLeft: ['prev', 'keys'], MediaTrackPrevious: ['prev', 'keys'],
}
/** Older key codes for the volume keys (Chromium 175/174, Firefox 183/182). */
const BY_CODE: Record<number, [HwAction, HwSource]> = { 175: ['primary', 'volume'], 174: ['secondary', 'volume'], 183: ['primary', 'volume'], 182: ['secondary', 'volume'] }

export class HardwareButtons {
  onAction?: (action: HwAction, down: boolean, source: HwSource) => void
  /** Sources that have worked on this device. */
  readonly seen = new Set<HwSource>()
  private held = new Set<HwAction>()
  private audio: HTMLAudioElement | null = null

  constructor() {
    addEventListener('keydown', (e) => this.key(e, true), { capture: true })
    addEventListener('keyup', (e) => this.key(e, false), { capture: true })
    addEventListener('blur', () => { for (const a of [...this.held]) { this.held.delete(a); this.onAction?.(a, false, 'keys') } })
  }

  private key(e: KeyboardEvent, down: boolean) {
    const t = e.target as HTMLElement | null
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    const hit = BY_KEY[e.key] ?? BY_KEY[e.code] ?? BY_CODE[e.keyCode]
    if (!hit || (typing && hit[1] !== 'volume')) return
    // Where the browser lets the page decide, a volume key then acts instead of changing the volume.
    e.preventDefault()
    const [action, source] = hit
    if (down) { if (this.held.has(action)) return; this.held.add(action) } else if (!this.held.delete(action)) return
    this.seen.add(source)
    this.onAction?.(action, down, source)
  }

  /** Headset buttons: hold a media session with a silent track. Call from a tap (autoplay rules). */
  async enableHeadset(title: string): Promise<boolean> {
    if (!('mediaSession' in navigator)) return false
    if (!this.audio) { this.audio = new Audio(silentWav()); this.audio.loop = true }
    try { await this.audio.play() } catch { return false }
    const session = navigator.mediaSession
    try { session.metadata = new MediaMetadata({ title, artist: 'ob.Pal controller' }) } catch { /* no metadata */ }
    const press = (action: HwAction) => () => {
      this.seen.add('headset')
      this.onAction?.(action, true, 'headset')
      this.onAction?.(action, false, 'headset')
      // A press pauses the track: keep it going so the session (and the next press) stays with the controller.
      void this.audio?.play().catch(() => {})
      session.playbackState = 'playing'
    }
    for (const [name, action] of [['play', 'primary'], ['pause', 'primary'], ['nexttrack', 'next'], ['previoustrack', 'prev']] as const) {
      try { session.setActionHandler(name, press(action)) } catch { /* action unsupported */ }
    }
    session.playbackState = 'playing'
    return true
  }

  disableHeadset() {
    this.audio?.pause()
    if (!('mediaSession' in navigator)) return
    for (const name of ['play', 'pause', 'nexttrack', 'previoustrack'] as const) {
      try { navigator.mediaSession.setActionHandler(name, null) } catch { /* action unsupported */ }
    }
    navigator.mediaSession.playbackState = 'none'
  }
}

/** One second of 8 kHz 8-bit silence as a WAV data URL. */
function silentWav(): string {
  const n = 8000
  const b = new Uint8Array(44 + n)
  const v = new DataView(b.buffer)
  const s = (o: number, t: string) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i) }
  s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVE'); s(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true)
  v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, 'data'); v.setUint32(40, n, true)
  b.fill(128, 44)
  let bin = ''
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i])
  return `data:audio/wav;base64,${btoa(bin)}`
}
