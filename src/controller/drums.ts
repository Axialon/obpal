/** Multitouch drums and a held-to-arm drumstick, using the phone's shared motion and haptics. */
import { DRUMS, padVelocity, StrikeDetector, strikeDrum } from '../music'
import type { Motion } from './motion'
import { requestMotionPermission } from './motion'
import { tick } from './haptics'
import type { MusicWire } from './music'
import '../styles/music.css'
import { html, setMarkup } from '../ui/markup'

export class Drums {
  private el!: HTMLElement
  private active = false
  private hand = false
  private strike = false
  private held = false
  private detector = new StrikeDetector()
  private lastPointer = { x: 0, y: 0, at: 0 }
  constructor(private wire: MusicWire, private motion: Motion) {}
  mount(parent: HTMLElement) {
    this.el = document.createElement('section')
    this.el.className = 'music-face drums-face'
    this.el.hidden = true
    this.el.setAttribute('aria-label', 'Drum pads')
    setMarkup(this.el, html`<div class="music-heading"><b>Drums</b><span class="music-part">Your instrument</span></div>
      <div class="music-options"><label>Layout<select aria-label="Drum layout"><option value="kit">Kit</option><option value="hand">Hand drums</option></select></label><button type="button" class="music-toggle" aria-pressed="false">Strike mode</button></div>
      <div class="drum-pads"></div><button type="button" class="strike-pad" hidden><b>Hold to play</b><span>Small swings · tilt to choose a drum</span><small>Keep a secure grip</small></button><p class="music-hint">Centre hits harder · play with both hands</p>`)
    parent.querySelector('#pad')!.before(this.el)
    this.el.querySelector('select')!.onchange = e => { this.hand = (e.target as HTMLSelectElement).value === 'hand'; this.draw() }
    this.el.querySelector<HTMLButtonElement>('.music-toggle')!.onclick = () => {
      this.strike = !this.strike; this.held = false; this.detector.reset()
      if (this.strike) void requestMotionPermission()
      this.draw()
    }
    const arm = this.el.querySelector<HTMLButtonElement>('.strike-pad')!
    arm.onpointerdown = e => { e.preventDefault(); arm.setPointerCapture(e.pointerId); this.held = true; this.detector.reset(); arm.classList.add('playing') }
    const release = () => { this.held = false; arm.classList.remove('playing') }
    arm.onpointerup = arm.onpointercancel = arm.onlostpointercapture = release
    addEventListener('blur', release)
    document.addEventListener('visibilitychange', () => { if (document.hidden) release() })
    this.draw()
  }
  private draw() {
    const ids = this.hand ? [9, 10, 11, 12] : [7, 6, 8, 3, 5, 2, 0, 4, 1]
    const pads = this.el.querySelector<HTMLElement>('.drum-pads')!
    pads.classList.toggle('hand-drums', this.hand)
    pads.hidden = this.strike
    this.el.querySelector<HTMLElement>('.strike-pad')!.hidden = !this.strike
    this.el.querySelector('.music-toggle')!.setAttribute('aria-pressed', String(this.strike))
    pads.replaceChildren(...ids.map(n => {
      const b = document.createElement('button')
      b.type = 'button'; b.dataset.drum = String(n); b.className = 'music-pad'
      setMarkup(b, html`<i aria-hidden="true"></i><span>${DRUMS[n]}</span>`)
      b.onpointermove = e => { this.lastPointer = { x: e.clientX, y: e.clientY, at: e.timeStamp } }
      b.onpointerdown = e => {
        e.preventDefault(); b.setPointerCapture(e.pointerId)
        const r = b.getBoundingClientRect()
        const dist = Math.hypot((e.clientX - r.x - r.width / 2) / (r.width / 2), (e.clientY - r.y - r.height / 2) / (r.height / 2))
        const dt = e.timeStamp - this.lastPointer.at
        const speed = dt > 0 && dt < 80 ? Math.hypot(e.clientX - this.lastPointer.x, e.clientY - this.lastPointer.y) / dt : 0
        this.hit(n, padVelocity(e.pressure, e.width, e.height, dist, speed), e.timeStamp)
      }
      b.onclick = e => { if (e.detail === 0) this.hit(n, 0.7) }
      return b
    }))
  }
  hit(n: number, velocity = 0.75, at = performance.now()) {
    if (!this.active) return
    this.wire.event('hit', n, velocity, 0, at); tick()
    const b = this.el.querySelector<HTMLElement>(`[data-drum="${n}"]`)
    b?.classList.remove('playing'); if (b) { void b.offsetWidth; b.classList.add('playing'); setTimeout(() => b.classList.remove('playing'), 110) }
    this.el.querySelector('.music-hint')!.textContent = `${DRUMS[n]} · ${Math.round(velocity * 100)}%`
  }
  sample() {
    if (!this.active || !this.strike || !this.held) return
    if (!this.motion.accel) { this.el.querySelector('.music-hint')!.textContent = 'Motion unavailable · use the pads'; return }
    const v = this.detector.sample(Math.hypot(...this.motion.accel), performance.now())
    if (v !== null) this.hit(strikeDrum(this.motion.up(), this.hand), v)
  }
  sync(active: boolean, part: string) {
    this.active = active; this.el.hidden = !active
    this.el.querySelector('.music-part')!.textContent = part || 'Choose an instrument in the scene'
    if (!active) this.held = false
  }
  hardware(target: string, down: boolean) {
    const n = ['kick', 'snare', 'hat'].indexOf(target)
    if (down && n >= 0) this.hit(n)
  }
}
