/** Scale degrees under each finger, with a held sustain pedal and an orientation-controlled air voice. */
import { clamp, padVelocity, scaleNote, type Scale } from '../music'
import { TiltStick } from './gyro'
import { tick } from './haptics'
import type { Motion } from './motion'
import { requestMotionPermission } from './motion'
import type { MusicWire } from './music'
import { html, setMarkup } from '../ui/markup'

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

export class Keys {
  private el!: HTMLElement
  private active = false
  private root = 0
  private scale: Scale = 'pentatonic'
  private octave = 4
  private fingers = new Map<number, number>()
  private sustained = new Set<number>()
  private sustain = false
  private air = false
  private tilt = new TiltStick(0, 30, 1)
  private sampled = 0
  constructor(private wire: MusicWire, private motion: Motion) {}
  mount(parent: HTMLElement) {
    this.el = document.createElement('section'); this.el.className = 'music-face keys-face'; this.el.hidden = true
    this.el.setAttribute('aria-label', 'Tone keys')
    setMarkup(this.el, html`<div class="music-heading"><b>Keys</b><span class="music-part"></span></div>
      <div class="music-options"><label>Key<select aria-label="Musical key">${NOTE_NAMES.map((s, n) => html`<option value="${n}">${s}</option>`)}</select></label>
      <label>Scale<select aria-label="Scale"><option value="pentatonic">Pentatonic</option><option value="major">Major</option><option value="minor">Minor</option></select></label>
      <button type="button" aria-label="Octave down">−</button><output aria-label="Octave">4</output><button type="button" aria-label="Octave up">+</button></div>
      <div class="tone-keys"></div><div class="keys-expression"><button type="button" class="sustain">Hold to sustain</button><button type="button" class="air-pad">Hold for Air</button><button type="button" class="music-toggle" aria-label="Level tilt bend">Level</button></div><p class="music-hint">Tilt to bend · every key belongs</p>`)
    parent.querySelector('#pad')!.before(this.el)
    this.el.querySelector<HTMLSelectElement>('[aria-label="Musical key"]')!.onchange = e => { this.reset(); this.root = Number((e.target as HTMLSelectElement).value); this.draw() }
    this.el.querySelector<HTMLSelectElement>('[aria-label="Scale"]')!.onchange = e => { this.reset(); this.scale = (e.target as HTMLSelectElement).value as Scale; this.draw() }
    this.el.querySelector<HTMLButtonElement>('[aria-label="Octave down"]')!.onclick = () => this.shift(-1)
    this.el.querySelector<HTMLButtonElement>('[aria-label="Octave up"]')!.onclick = () => this.shift(1)
    this.el.querySelector<HTMLButtonElement>('[aria-label="Level tilt bend"]')!.onclick = () => { void requestMotionPermission(); this.tilt.capture(this.motion.up()) }
    this.bindHold('.sustain', on => this.pedal(on))
    this.bindHold('.air-pad', on => {
      this.air = on
      if (on) { void requestMotionPermission(); this.tilt.capture(this.motion.up()); this.wire.event('air', this.note(0), 0.5) }
      else this.wire.event('off', 127)
    })
    addEventListener('blur', () => this.reset())
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset() })
    this.draw()
  }
  private bindHold(selector: string, set: (on: boolean) => void) {
    const b = this.el.querySelector<HTMLButtonElement>(selector)!
    const pointers = new Set<number>()
    b.onpointerdown = e => { e.preventDefault(); b.setPointerCapture(e.pointerId); pointers.add(e.pointerId); set(true); b.classList.add('playing') }
    const up = (e: PointerEvent) => { pointers.delete(e.pointerId); if (!pointers.size) { set(false); b.classList.remove('playing') } }
    b.onpointerup = b.onpointercancel = b.onlostpointercapture = up
    b.onkeydown = e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); set(true); b.classList.add('playing') } }
    b.onkeyup = e => { if (e.key === ' ' || e.key === 'Enter') { set(false); b.classList.remove('playing') } }
  }
  private note(degree: number) { return scaleNote(degree, this.root, this.octave, this.scale) }
  private shift(by: number) { this.reset(); this.octave = clamp(this.octave + by, 2, 6); this.draw() }
  private draw() {
    this.el.querySelector('output')!.textContent = String(this.octave)
    this.el.querySelector('.tone-keys')!.replaceChildren(...Array.from({ length: 8 }, (_, d) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tone-key'; b.dataset.degree = String(d)
      const note = this.note(d)
      setMarkup(b, html`<small>${d + 1}</small><span>${NOTE_NAMES[note % 12]}</span>`)
      b.setAttribute('aria-label', `Play ${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`)
      b.onpointerdown = e => {
        e.preventDefault(); b.setPointerCapture(e.pointerId)
        this.down(e.pointerId, note, padVelocity(e.pressure, e.width, e.height, 0.3), e.timeStamp)
        b.classList.add('playing')
      }
      const up = (e: PointerEvent) => { this.up(e.pointerId); if (![...this.fingers.values()].includes(note)) b.classList.remove('playing') }
      b.onpointerup = b.onpointercancel = b.onlostpointercapture = up
      b.onkeydown = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) { this.down(-d - 1, note, 0.7); b.classList.add('playing') } } }
      b.onkeyup = e => { if (e.key === ' ' || e.key === 'Enter') { this.up(-d - 1); b.classList.remove('playing') } }
      return b
    }))
  }
  private down(id: number, note: number, v: number, at = performance.now()) {
    if (!this.active) return
    if (!this.fingers.size) this.tilt.capture(this.motion.up())
    this.fingers.set(id, note); this.sustained.delete(note); this.wire.event('on', note, v, 0, at); tick()
  }
  private up(id: number) {
    const note = this.fingers.get(id); this.fingers.delete(id)
    if (note === undefined || [...this.fingers.values()].includes(note)) return
    if (this.sustain) this.sustained.add(note)
    else this.wire.event('off', note)
  }
  private pedal(on: boolean) {
    this.sustain = on
    if (!on) { for (const n of this.sustained) this.wire.event('off', n); this.sustained.clear() }
  }
  reset() {
    if (this.fingers.size || this.sustained.size || this.air) this.wire.event('stop')
    this.fingers.clear(); this.sustained.clear(); this.air = this.sustain = false
    this.el?.querySelectorAll('.playing').forEach(b => b.classList.remove('playing'))
  }
  sample() {
    if (!this.active || !this.motion.q || performance.now() - this.sampled < 33) return
    this.sampled = performance.now()
    const [roll, pitch] = this.tilt.angles(this.motion.up())
    if (this.air) this.wire.event('air', this.note(Math.round(clamp(pitch / 30, -1, 1) * 7)), clamp((roll + 40) / 80, 0.12))
    else if (this.fingers.size || this.sustained.size) this.wire.event('bend', 0, 0, clamp(roll / 25, -1, 1))
  }
  sync(active: boolean, part: string) {
    if (this.active && !active) this.reset()
    this.active = active; this.el.hidden = !active
    this.el.querySelector('.music-part')!.textContent = part || 'Choose an instrument in the scene'
  }
  hardware(target: string, down: boolean, tap: boolean) {
    if (target === 'sustain') { this.pedal(down); return }
    if (target === 'octaveup' || target === 'octavedown') { if (down) this.shift(target === 'octaveup' ? 1 : -1); return }
    const d = Number(target.replace('note', '')) - 1
    if (!/^note[1-8]$/.test(target)) return
    if (down) { this.down(100 + d, this.note(d), 0.7); if (tap) setTimeout(() => this.up(100 + d), 150) }
    else this.up(100 + d)
  }
}
