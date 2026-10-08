import { emptyPad, emptyState, encodePad, encodeState, Flag, Mode, type DeviceMsg, type Layout } from '@obpal/core'
import type { Remote } from '@obpal/host'
import { iconAction } from '../ui/kit/action'
import '../styles/share.css'

export interface LocalInputSink { id: string; pad(data: ArrayBuffer): void; state(data: ArrayBuffer): void; control(message: DeviceMsg): void; close(): void }
/** The native keyboard, mouse and gamepad picker installs its launcher here. */
export let localInputSource: ((mode?: string) => (() => void)) | null = null
let localUnit: (() => string | undefined) | null = null
export function installLocalInputSource(source: NonNullable<typeof localInputSource>, unit?: () => string | undefined) { localInputSource = source; localUnit = unit ?? null }

/** Touch uses the STATE/PAD and tray path that Seats converts to DeviceInput for paired phones. */
export class PhonePlay {
  readonly root = document.createElement('div')
  private pad = emptyPad()
  private state = emptyState()
  private tilt = false
  private zero: [number, number] | null = null
  private resetSticks: (() => void)[] = []
  private timer: ReturnType<typeof setInterval>
  private closed = false
  private cameraActive = false
  private sensor = (e: DeviceOrientationEvent) => {
    if (document.hidden || this.cameraActive || !this.tilt || e.beta === null || e.gamma === null || !Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return
    this.zero ??= [e.gamma, e.beta]
    this.state.tilt = [Math.max(-1, Math.min(1, (e.gamma - this.zero[0]) / 25)), Math.max(-1, Math.min(1, (e.beta - this.zero[1]) / 25))]
  }
  constructor(private sink: LocalInputSink, layout: Layout, sim: string, simOnly = false, selection?: { units: readonly { id: string; name: string }[]; selected: string; change: (id: string) => void }) {
    this.root.className = 'phone-play glass'; this.root.setAttribute('role', 'toolbar'); this.root.setAttribute('aria-label', 'On-screen controls')
    this.state.mode = Mode.gamepad; sink.control({ t: 'mode', m: Mode.gamepad, c: 'face.gamepad' })
    if (selection) {
      const label = document.createElement('label'); label.className = 'phone-play-unit'; label.append('On-screen controls · ')
      const select = document.createElement('select'); select.setAttribute('aria-label', 'On-screen unit')
      select.replaceChildren(...selection.units.map(unit => { const option = document.createElement('option'); option.value = unit.id; option.textContent = unit.name; return option }))
      select.value = selection.selected; select.onchange = () => { this.release(); selection.change(select.value) }; label.append(select); this.root.append(label)
    }
    this.root.append(this.stick(0, sim === 'trebuchet' ? 'Counterweight' : sim === 'drone' ? 'Turn and height' : 'Move'), this.stick(2, sim === 'trebuchet' ? 'Release angle' : sim === 'drone' ? 'Fly' : 'Look / lift'))
    const buttons = document.createElement('div'); buttons.className = 'phone-play-buttons'
    for (const tray of layout.tray.filter(t => !t.id.startsWith('drops.') && (!t.type || t.type === 'button')).slice(0, 7)) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = tray.label; if (tray.icon) iconAction(b, tray.icon, tray.label)
      if (tray.icon) { b.classList.remove('kit-icon-action'); const name = document.createElement('span'); name.textContent = tray.label; b.append(name) }
      b.onclick = () => { if (!this.cameraActive && !document.hidden) sink.control({ t: 'btn', id: tray.id, ev: 'tap' }) }; buttons.append(b)
    }
    for (const [id, glyph, label] of simOnly ? [] : [['undo', 'undo', 'Undo drop'], ['clear', 'reset', 'Clear drops'], ['toggle', 'plus', 'Drop-ins']]) {
      const b = document.createElement('button'); b.type = 'button'; iconAction(b, glyph, label); b.onclick = () => sink.control({ t: 'btn', id: `drops.${id}`, ev: 'tap' }); buttons.append(b)
      if (id === 'toggle') b.setAttribute('aria-pressed', document.body.dataset.dropsEnabled ?? 'false')
    }
    const sensors = document.createElement('button'); sensors.type = 'button'; iconAction(sensors, 'tilt', 'Tilt controls')
    sensors.onclick = async () => {
      const EventType = DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> }
      try { if (EventType.requestPermission && await EventType.requestPermission() !== 'granted') return } catch { return }
      this.release(); this.tilt = !this.tilt; this.zero = null; sensors.setAttribute('aria-pressed', String(this.tilt)); this.state.mode = this.tilt ? Mode.tilt : Mode.gamepad
      sink.control({ t: 'mode', m: this.state.mode, c: this.tilt ? 'face.trackpad' : 'face.gamepad' })
    }
    if (!simOnly && ['marblerun', 'kart', 'maze', 'drone'].includes(sim)) buttons.append(sensors)
    const exit = document.createElement('button'); exit.type = 'button'; iconAction(exit, 'close', 'Leave local play'); exit.onclick = () => this.close(); buttons.append(exit)
    const camera = document.createElement('button'); camera.type = 'button'; iconAction(camera, 'camera', 'Camera mode'); camera.setAttribute('aria-pressed', 'false')
    camera.onclick = () => { this.release(); const active = this.cameraActive = !this.cameraActive; camera.setAttribute('aria-pressed', String(active)); document.body.classList.toggle('phone-camera-mode', active); dispatchEvent(new CustomEvent('obpal:phonecamera', { detail: active })) }; buttons.append(camera)
    if (selection) { const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = 'Choose controls'; choose.onclick = () => dispatchEvent(new CustomEvent('obpal:localplay', { detail: 'choose' })); buttons.append(choose) }
    this.root.append(buttons); document.body.append(this.root); document.body.classList.add('phone-playing')
    dispatchEvent(new CustomEvent('obpal:phonecamera', { detail: false }))
    addEventListener('deviceorientation', this.sensor); addEventListener('blur', this.release); document.addEventListener('visibilitychange', this.hidden)
    this.timer = setInterval(() => this.send(), 1000 / 30)
  }
  private stick(offset: 0 | 2, label: string) {
    const stick = document.createElement('div'); stick.className = 'phone-stick'; stick.setAttribute('aria-label', label); stick.setAttribute('role', 'group')
    const title = document.createElement('span'); title.className = 'phone-stick-label'; title.textContent = label; stick.append(title)
    const knob = document.createElement('i'); stick.append(knob)
    let pointer: number | null = null
    this.resetSticks.push(() => { const active = pointer; pointer = null; if (active !== null && stick.hasPointerCapture(active)) stick.releasePointerCapture(active); knob.style.transform = '' })
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return
      const r = stick.getBoundingClientRect(), x = Math.max(-1, Math.min(1, (e.clientX - r.x - r.width / 2) / (r.width * .38))), y = Math.max(-1, Math.min(1, (e.clientY - r.y - r.height / 2) / (r.height * .38)))
      this.pad.axes[offset] = x; this.pad.axes[offset + 1] = y
      if (this.tilt) this.state.tilt = [x, y]
      knob.style.transform = `translate(${x * 24}px, ${y * 24}px)`; this.send()
    }
    stick.onpointerdown = e => { if (pointer !== null || this.cameraActive || document.hidden) return; e.preventDefault(); pointer = e.pointerId; stick.setPointerCapture(pointer); move(e) }
    stick.onpointermove = move
    const release = (e: PointerEvent) => { if (e.pointerId !== pointer) return; const held = pointer; pointer = null; if (stick.hasPointerCapture(held)) stick.releasePointerCapture(held); this.pad.axes[offset] = this.pad.axes[offset + 1] = 0; if (this.tilt) this.state.tilt = [0, 0]; knob.style.transform = ''; this.send() }
    stick.onpointerup = release; stick.onpointercancel = release; stick.onlostpointercapture = release
    return stick
  }
  private send(force = false) {
    if (this.closed || (document.hidden && !force)) return
    const now = performance.now(); this.pad.seq++; this.pad.t = this.state.t = now * 1000; this.state.seq++
    this.state.touches = this.pad.axes.some(x => Math.abs(x) > .02) ? 1 : 0; this.state.flags = this.state.touches ? Flag.touching : 0
    if (this.tilt) this.sink.state(encodeState(this.state)); else this.sink.pad(encodePad(this.pad))
  }
  private release = () => { this.resetSticks.forEach(reset => reset()); this.pad.axes = [0, 0, 0, 0]; this.pad.buttons = 0; this.pad.triggers = [0, 0]; this.state.tilt = [0, 0]; this.zero = null; this.send(true) }
  private hidden = () => { if (document.hidden) this.release() }
  close(disconnect = true) { if (this.closed) return; this.release(); this.closed = true; clearInterval(this.timer); if (disconnect) this.sink.close(); this.root.remove(); document.body.classList.remove('phone-playing', 'phone-camera-mode'); dispatchEvent(new CustomEvent('obpal:phonecamera', { detail: 'leave' })); removeEventListener('deviceorientation', this.sensor); removeEventListener('blur', this.release); document.removeEventListener('visibilitychange', this.hidden) }
}

export function mountLocalPlay(remote: Remote, layout: Layout, firstNode?: string, units: () => readonly { id: string; name: string }[] = () => [], available: (node: string) => boolean = () => true) {
  let phone: PhonePlay | null = null, stop: (() => void) | null = null
  const sim = new URLSearchParams(location.search).get('d') ?? location.pathname.split('/')[2]
  const entry = document.createElement('div'); entry.className = 'local-play-entry'
  const play = (mode: string) => {
    phone?.close(); stop?.()
    phone = null; stop = null
    if (mode === 'release') return
    if (!['phone', 'touch'].includes(mode)) { stop = localInputSource?.(mode) ?? null; return }
    stop = localInputSource?.('touch') ?? null
    const selected = localUnit?.() ?? firstNode
    if (selected && !available(selected)) return
    if (remote.participants.filter(p => p.capability !== 'watch').length >= 8) return
    const sink = remote.localInputSource('On-screen controls')
    if (selected) sink.control({ t: 'claim', node: selected })
    phone = new PhonePlay(sink, layout, sim, false, selected && units().length ? { units: units(), selected, change: id => { dispatchEvent(new CustomEvent('obpal:localunit', { detail: id })); play('touch') } } : undefined)
  }
  // Every sim entry opens the same chooser; touch availability never depends on an attached mouse.
  const here = document.createElement('button'); here.type = 'button'; here.className = 'kit-action'; here.textContent = 'Play here'
  here.title = 'Choose on-screen controls, keyboard, mouse or gamepad on this scene'
  here.onclick = () => play('choose'); entry.append(here)
  document.querySelector('.presence-controls')?.after(entry)
  addEventListener('obpal:localplay', e => play((e as CustomEvent<string>).detail))
  addEventListener('pagehide', () => { phone?.close(); stop?.() }, { once: true })
  // Entry links open the chooser; neither a saved preference nor a reload arms input.
  if (new URLSearchParams(location.search).has('local')) setTimeout(() => play('choose'), 0)
}
