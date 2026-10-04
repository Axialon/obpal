import { emptyPad, emptyState, encodePad, encodeState, Flag, Mode, type DeviceMsg, type Layout } from '@obpal/core'
import type { Remote } from '@obpal/host'
import { iconAction } from '../ui/kit/action'
import '../styles/share.css'

export interface LocalInputSink { id: string; pad(data: ArrayBuffer): void; state(data: ArrayBuffer): void; control(message: DeviceMsg): void; close(): void }
/** The native keyboard, mouse and gamepad picker installs its launcher here. */
export let localInputSource: (() => (() => void)) | null = null
export function installLocalInputSource(source: NonNullable<typeof localInputSource>) { localInputSource = source }

/** Touch uses the STATE/PAD and tray path that Seats converts to DeviceInput for paired phones. */
export class PhonePlay {
  readonly root = document.createElement('div')
  private pad = emptyPad()
  private state = emptyState()
  private tilt = false
  private zero: [number, number] | null = null
  private resetSticks: (() => void)[] = []
  private timer: ReturnType<typeof setInterval>
  private sensor = (e: DeviceOrientationEvent) => {
    if (document.hidden || !this.tilt || e.beta === null || e.gamma === null || !Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return
    this.zero ??= [e.gamma, e.beta]
    this.state.tilt = [Math.max(-1, Math.min(1, (e.gamma - this.zero[0]) / 25)), Math.max(-1, Math.min(1, (e.beta - this.zero[1]) / 25))]
  }
  constructor(private sink: LocalInputSink, layout: Layout, sim: string, simOnly = false) {
    this.root.className = 'phone-play glass'; this.root.setAttribute('role', 'toolbar'); this.root.setAttribute('aria-label', 'On-screen controls')
    this.state.mode = Mode.gamepad; sink.control({ t: 'mode', m: Mode.gamepad, c: 'face.gamepad' })
    this.root.append(this.stick(0, sim === 'drone' ? 'Turn and height' : 'Move'), this.stick(2, sim === 'drone' ? 'Fly' : 'Look / lift'))
    const buttons = document.createElement('div'); buttons.className = 'phone-play-buttons'
    for (const tray of layout.tray.filter(t => !t.id.startsWith('drops.') && (!t.type || t.type === 'button')).slice(0, 7)) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = tray.label; if (tray.icon) iconAction(b, tray.icon, tray.label)
      b.onclick = () => sink.control({ t: 'btn', id: tray.id, ev: 'tap' }); buttons.append(b)
    }
    for (const [id, glyph, label] of simOnly ? [] : [['undo', 'undo', 'Undo drop'], ['clear', 'reset', 'Clear drops'], ['toggle', 'plus', 'Drop-ins']]) {
      const b = document.createElement('button'); b.type = 'button'; iconAction(b, glyph, label); b.onclick = () => sink.control({ t: 'btn', id: `drops.${id}`, ev: 'tap' }); buttons.append(b)
      if (id === 'toggle') b.setAttribute('aria-pressed', document.body.dataset.dropsEnabled ?? 'false')
    }
    const sensors = document.createElement('button'); sensors.type = 'button'; iconAction(sensors, 'tilt', 'Tilt controls')
    sensors.onclick = async () => {
      const EventType = DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> }
      try { if (EventType.requestPermission && await EventType.requestPermission() !== 'granted') return } catch { return }
      this.tilt = !this.tilt; this.zero = null; sensors.setAttribute('aria-pressed', String(this.tilt)); this.state.mode = this.tilt ? Mode.tilt : Mode.gamepad
      sink.control({ t: 'mode', m: this.state.mode, c: this.tilt ? 'face.trackpad' : 'face.gamepad' })
    }
    if (!simOnly && ['marblerun', 'kart', 'maze', 'drone'].includes(sim)) buttons.append(sensors)
    const exit = document.createElement('button'); exit.type = 'button'; iconAction(exit, 'close', 'Leave local play'); exit.onclick = () => this.close(); buttons.append(exit)
    const camera = document.createElement('button'); camera.type = 'button'; iconAction(camera, 'camera', 'Camera mode'); camera.setAttribute('aria-pressed', 'false')
    camera.onclick = () => { this.release(); const active = camera.getAttribute('aria-pressed') !== 'true'; camera.setAttribute('aria-pressed', String(active)); document.body.classList.toggle('phone-camera-mode', active); dispatchEvent(new CustomEvent('obpal:phonecamera', { detail: active })) }; buttons.append(camera)
    this.root.append(buttons); document.body.append(this.root); document.body.classList.add('phone-playing')
    dispatchEvent(new CustomEvent('obpal:phonecamera', { detail: false }))
    addEventListener('deviceorientation', this.sensor); addEventListener('blur', this.release); document.addEventListener('visibilitychange', this.hidden)
    this.timer = setInterval(() => this.send(), 1000 / 30)
  }
  private stick(offset: 0 | 2, label: string) {
    const stick = document.createElement('div'); stick.className = 'phone-stick'; stick.setAttribute('aria-label', label); stick.setAttribute('role', 'group')
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
    stick.onpointerdown = e => { if (pointer !== null) return; pointer = e.pointerId; stick.setPointerCapture(pointer); move(e) }
    stick.onpointermove = move
    const release = (e: PointerEvent) => { if (e.pointerId !== pointer) return; pointer = null; this.pad.axes[offset] = this.pad.axes[offset + 1] = 0; knob.style.transform = ''; this.send() }
    stick.onpointerup = release; stick.onpointercancel = release
    return stick
  }
  private send(force = false) {
    if (document.hidden && !force) return
    const now = performance.now(); this.pad.seq++; this.pad.t = this.state.t = now * 1000; this.state.seq++
    this.state.flags = Flag.touching; this.state.touches = this.pad.axes.some(x => Math.abs(x) > .02) ? 1 : 0
    if (this.tilt) this.sink.state(encodeState(this.state)); else this.sink.pad(encodePad(this.pad))
  }
  private release = () => { this.resetSticks.forEach(reset => reset()); this.pad.axes = [0, 0, 0, 0]; this.pad.buttons = 0; this.pad.triggers = [0, 0]; this.state.tilt = [0, 0]; this.zero = null; this.send(true) }
  private hidden = () => { if (document.hidden) this.release() }
  close(disconnect = true) { this.release(); clearInterval(this.timer); if (disconnect) this.sink.close(); this.root.remove(); document.body.classList.remove('phone-playing', 'phone-camera-mode'); dispatchEvent(new CustomEvent('obpal:phonecamera', { detail: 'leave' })); removeEventListener('deviceorientation', this.sensor); removeEventListener('blur', this.release); document.removeEventListener('visibilitychange', this.hidden) }
}

export function mountLocalPlay(remote: Remote, layout: Layout, firstNode?: string) {
  let phone: PhonePlay | null = null, stop: (() => void) | null = null
  const sim = new URLSearchParams(location.search).get('d') ?? location.pathname.split('/')[2]
  const entry = document.createElement('div'); entry.className = 'local-play-entry'
  const play = (mode: string) => {
    phone?.close(); stop?.()
    phone = null; stop = null
    if (mode !== 'phone') { stop = localInputSource?.() ?? null; return }
    if (remote.participants.filter(p => p.capability !== 'watch').length >= 8) return
    const sink = remote.localInputSource('This phone')
    if (firstNode) sink.control({ t: 'claim', node: firstNode })
    phone = new PhonePlay(sink, layout, sim)
  }
  // One way in from the window: Play here, which on a device without a fine pointer (a phone or a touch tablet) is its
  // on-screen sticks and elsewhere this computer's keyboard, mouse or gamepad. Both stay in the Share panel by name (ui/share-panel.ts).
  const touch = !matchMedia('(any-pointer: fine)').matches
  const here = document.createElement('button'); here.type = 'button'; here.className = 'kit-action'; here.textContent = 'Play here'
  here.title = touch ? 'On-screen controls on this device' : 'This device’s keyboard, mouse or gamepad'
  here.onclick = () => play(touch ? 'phone' : 'local'); entry.append(here)
  document.querySelector('.presence-controls')?.after(entry)
  addEventListener('obpal:localplay', e => play((e as CustomEvent<string>).detail))
  addEventListener('pagehide', () => { phone?.close(); stop?.() }, { once: true })
  if (new URLSearchParams(location.search).get('local') === 'phone') setTimeout(() => play('phone'), 0)
  if (new URLSearchParams(location.search).get('local') === 'here') setTimeout(() => play('local'), 0)
}
