/** Multitouch drums and a held-to-arm drumstick, using the phone's shared motion and haptics. */
import { DRUMS, padVelocity, SpatialStrike } from '../music'
import { instrumentTargets, musicTarget, STATION_NAMES, STUDIO_TARGETS } from '../music-space'
import type { CalibratedControl } from './control-space'
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
  private detector = new SpatialStrike()
  private seat = 0
  private mapKey = ''
  private marks = new Map<string, SVGCircleElement>()
  private highlight: SVGCircleElement | null = null
  get aiming() { return this.active && this.strike }
  private lastPointer = { x: 0, y: 0, at: 0 }
  constructor(private wire: MusicWire, private motion: Motion, private control: CalibratedControl) {}
  mount(parent: HTMLElement) {
    this.mapKey = ''; this.marks.clear(); this.highlight = null
    this.el = document.createElement('section')
    this.el.className = 'music-face drums-face'
    this.el.hidden = true
    this.el.setAttribute('aria-label', 'Drum pads')
    setMarkup(this.el, html`<div class="music-heading"><b>Drums</b><span class="music-part">Your instrument</span></div>
      <div class="music-options"><label>Layout<select aria-label="Drum layout"><option value="kit">Kit</option><option value="hand">Hand drums</option></select></label><button type="button" class="music-toggle" aria-pressed="false">Strike mode</button></div>
      <div class="drum-pads"></div><button type="button" class="strike-pad" hidden><b>Hold to play</b><svg class="strike-map" viewBox="-100 -100 200 200" aria-hidden="true"></svg><span>Point to aim · flick down to strike</span><small>Keep a secure grip · flick down gently</small></button><p class="music-hint">Centre hits harder · play with both hands</p>`)
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
    arm.onkeydown = e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); this.held = true; this.detector.reset(); arm.classList.add('playing') } }
    arm.onkeyup = e => { if (e.key === ' ' || e.key === 'Enter') release() }
    addEventListener('blur', release)
    document.addEventListener('visibilitychange', () => { if (document.hidden) release() })
    this.draw()
  }
  private draw() {
    this.el.querySelector('.music-heading b')!.textContent = this.strike ? 'Air stick' : 'Drums'
    this.el.querySelector<HTMLElement>('.music-options label')!.hidden = this.strike
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
    if (!this.active || !this.strike) return
    const state = this.control.sample()
    if (!state.active) return
    const aim = state.aim, scope = this.control.scope
    const target = musicTarget(aim, scope, this.seat)
    const key = `${scope}:${this.seat}`
    if (key !== this.mapKey) {
      this.mapKey = key; this.marks.clear(); this.highlight = null
      const svg = this.el.querySelector<SVGSVGElement>('svg.strike-map')!
      svg.replaceChildren()
      for (const t of scope === 'scene' ? STUDIO_TARGETS : instrumentTargets(this.seat)) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        dot.setAttribute('cx', String(t.x * 100)); dot.setAttribute('cy', String(-t.y * 100)); dot.setAttribute('r', scope === 'scene' ? '2.5' : this.seat >= 3 && this.seat <= 5 ? '3' : '5')
        svg.append(dot); this.marks.set(`${t.seat}:${t.surface}`, dot)
      }
      if (scope === 'scene') STATION_NAMES.forEach((name, n) => {
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        label.setAttribute('x', String((-0.72 + n % 4 * 0.48) * 100)); label.setAttribute('y', n < 4 ? '-94' : '6')
        label.textContent = name.replace('Electronic pads', 'Pads').replace('Warm synth', 'Synth').replace('Hand drums', 'Hand').replace('Drum kit', 'Kit').replace('Percussion', 'Perc.')
        svg.append(label)
      })
    }
    this.highlight?.classList.remove('aimed')
    this.highlight = this.marks.get(`${target.seat}:${target.surface}`) ?? null
    this.highlight?.classList.add('aimed')
    this.el.querySelector('.strike-pad span')!.textContent = `${scope === 'scene' ? STATION_NAMES[target.seat] + ' · ' : ''}${target.label}`
    if (!this.held) return
    if (!this.motion.accel || !this.motion.q) { this.release(); this.el.querySelector('.music-hint')!.textContent = 'Motion unavailable · use the pads'; return }
    const up = this.motion.up(), a = this.motion.accel
    const hit = this.detector.sample(-(a[0] * up[0] + a[1] * up[1] + a[2] * up[2]), aim, this.motion.sampleAt)
    if (hit) {
      const struck = musicTarget(hit.aim, scope, this.seat)
      this.wire.event('hit', 0, hit.v, 0, hit.at, { aim: hit.aim.map(n => Math.round(n * 10000) / 10000) as [number, number], scope }); tick()
      this.el.querySelector('.music-hint')!.textContent = `${struck.label} · ${Math.round(hit.v * 100)}%`
    }
  }
  release() { this.held = false; this.detector.reset(); this.el?.querySelector('.strike-pad')?.classList.remove('playing') }
  sync(active: boolean, part: string) {
    this.active = active; this.el.hidden = !active
    this.el.querySelector('.music-part')!.textContent = part || 'Choose an instrument in the scene'
    const seat = STATION_NAMES.findIndex(name => name === part)
    if (seat >= 0) this.seat = seat
    if (!active) this.release()
  }
  hardware(target: string, down: boolean) {
    const n = ['kick', 'snare', 'hat'].indexOf(target)
    if (down && n >= 0) this.hit(n)
  }
}
