/**
 * Orientation lock for motion control. While the phone steers with its gyro, turning it must not flip the layout or remap
 * the controls. A native lock (screen.orientation.lock: Android, in fullscreen) keeps the screen still. Where there is
 * none (iPhone, iPad, browsers that refuse), the page counter-rotates itself so the controls stay where they were.
 */
import { actualScreenAngle, setLockedScreenAngle } from './motion'
import { setUiRotation, uiRotation, uiSize } from './uiframe'

export type LockKind = 'native' | 'virtual'

async function attempt(f: () => Promise<unknown>) { try { await f(); return true } catch { return false } }

export class OrientationLock {
  kind: LockKind | null = null
  /** The screen angle the controls were locked at. */
  private angle = 0
  /** Whether fullscreen was entered for the lock (and should be left with it). */
  private enteredFullscreen = false
  /** The lock or the UI's rotation changed: re-layout; `reanchor` when motion's screen frame changed (an unlock). */
  onChange?: (reanchor: boolean) => void

  constructor() {
    const again = () => { if (this.kind === 'virtual') this.apply() }
    screen.orientation?.addEventListener?.('change', again)
    addEventListener('orientationchange', again)
    addEventListener('resize', again)
  }

  get locked() { return this.kind !== null }

  /** Lock at the current orientation. Call from a tap where possible: fullscreen (for the native lock) needs one. */
  async lock() {
    if (this.kind) return
    this.angle = actualScreenAngle()
    const so = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined
    if (so?.lock) {
      const type = so.type
      if (await attempt(() => so.lock!(type))) return this.set('native')
      if (!document.fullscreenElement && document.fullscreenEnabled && document.documentElement.requestFullscreen) {
        if (await attempt(() => document.documentElement.requestFullscreen({ navigationUI: 'hide' }))) {
          this.enteredFullscreen = true
          if (await attempt(() => so.lock!(type))) return this.set('native')
        }
      }
    }
    this.set('virtual')
  }

  unlock() {
    if (!this.kind) return
    if (this.kind === 'native') { try { screen.orientation.unlock() } catch { /* nothing to undo */ } }
    if (this.enteredFullscreen && document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    this.enteredFullscreen = false
    this.kind = null
    setLockedScreenAngle(null)
    this.apply()
    this.onChange?.(true)
  }

  private set(kind: LockKind) {
    this.kind = kind
    // Native: the screen can't turn, so its angle stays the locked one. Virtual: motion reads the locked angle.
    setLockedScreenAngle(kind === 'virtual' ? this.angle : null)
    this.apply()
    this.onChange?.(false)
  }

  /** The virtual lock: turn the page back by however far the screen has turned since locking. */
  private apply() {
    const html = document.documentElement
    const before = uiRotation()
    setUiRotation(this.kind === 'virtual' ? this.angle - actualScreenAngle() : 0)
    const turned = uiRotation() !== 0
    html.classList.toggle('vlock', turned)
    if (turned) {
      const { w, h } = uiSize()
      html.style.setProperty('--ui-w', `${w}px`)
      html.style.setProperty('--ui-h', `${h}px`)
      html.style.setProperty('--ui-rot', `${uiRotation()}deg`)
    } else for (const p of ['--ui-w', '--ui-h', '--ui-rot']) html.style.removeProperty(p)
    if (before !== uiRotation()) this.onChange?.(false)
  }
}
