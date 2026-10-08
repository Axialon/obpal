/** The sim's local-control picker and focused keyboard, mouse and touch surface. */
import type { TrayControl } from '@obpal/core'
import { ICONS } from '../ui/icons'
import { html, setMarkup } from '../ui/markup'
import { iconAction } from '../ui/kit/action'
import { fitControlInk } from '../ui/kit/ink'
import { enhanceSelect } from '../ui/kit/select'
import { simPanels } from './ui/panels'
import { LocalInput, liveInput, standardPad, type LocalSource } from './local-input'
import { installLocalInputSource } from './local-play'
import type { DeviceInput } from './devices/types'
import '../styles/local-control.css'

const editable = (target: EventTarget | null) => target instanceof Element && !!target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="dialog"]')
const cap = (code: string) => code.startsWith('Arrow') ? code.slice(5) : code.replace(/^Key|^Digit/, '').replace(/^Shift(Left|Right)$/, 'Shift')
function localAction(button: HTMLButtonElement, icon: string, label: string) {
  iconAction(button, icon, label)
  button.classList.remove('kit-icon-action')
  const span = document.createElement('span'); span.textContent = label; button.append(span)
  fitControlInk(button)
}
export interface LocalOptions {
  id: string
  canvas: HTMLCanvasElement
  units: () => readonly { id: string; name: string }[]
  tray?: readonly TrayControl[]
  phone: () => void
  controllerWindow: () => void
  changed?: () => void
  /** Live drivers need a held local deadman in addition to their existing arm step. */
  hardware?: () => boolean
  orbit?: (enabled: boolean) => void
}

export class LocalControls {
  readonly input: LocalInput
  readonly el = document.createElement('div')
  private status = document.createElement('p')
  private help = document.createElement('div')
  private arm: HTMLButtonElement
  private padChoice: HTMLButtonElement
  private select = document.createElement('select')
  private lastStatus = ''
  private lastHardware = false
  private remap: string | null = null
  private pointer: { id: number; x: number; y: number; touch: boolean } | null = null
  private stopped = false
  constructor(private readonly opts: LocalOptions) {
    const input = this.input = new LocalInput(() => opts.units().length, opts.tray)
    input.bindings.deadman = ['KeyZ']
    try {
      const saved = JSON.parse(localStorage.getItem(`obpal.local:${opts.id}`) ?? '{}')
      if (['keyboard', 'gamepad', 'touch', 'phone', 'window'].includes(saved.source)) input.source = saved.source
      if (Number.isInteger(saved.unit)) input.unit = Math.max(0, Math.min(opts.units().length - 1, saved.unit))
      for (const [id, codes] of Object.entries(saved.bindings ?? {})) if (id in input.bindings && Array.isArray(codes) && codes.every(c => typeof c === 'string' && /^(Key[A-Z]|Digit[1-9]|Arrow(Up|Down|Left|Right)|Space|Enter|Shift(Left|Right))$/.test(c))) input.bindings[id] = codes as string[]
    } catch { /* Storage is optional. */ }
    this.el.className = 'local-control'
    setMarkup(this.el, html`<div class="local-choices"></div><label class="local-unit"><span>Local unit</span></label><div class="local-actions"></div>`)
    const choices = this.el.querySelector('.local-choices')!
    const choice = (source: LocalSource, icon: string, label: string) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'kit-action local-choice'; b.dataset.source = source
      localAction(b, icon, label)
      b.onclick = () => { dispatchEvent(new CustomEvent('obpal:localplay', { detail: 'release' })); input.disarm(); input.source = source; this.save(); this.paint(); if (source === 'phone') opts.phone(); else if (source === 'window') opts.controllerWindow(); else if (source === 'touch') dispatchEvent(new CustomEvent('obpal:localplay', { detail: 'touch' })) }
      choices.append(b); return b
    }
    choice('phone', 'phone', 'Use your phone')
    choice('touch', 'tap', 'On-screen touch controls')
    choice('window', 'frame', 'Open the controller in another window')
    this.padChoice = choice('gamepad', 'gamepad', 'Gamepad detected · press any button')
    choice('keyboard', 'keyboard', 'Keyboard and mouse')
    this.select.setAttribute('aria-label', 'Local unit')
    this.select.onchange = () => { input.selectUnit(Number(this.select.value)); this.save(); this.paint() }
    this.el.querySelector('.local-unit')!.append(this.select)
    enhanceSelect(this.select)?.button.classList.add('local-select')
    this.status.className = 'local-status'; this.status.setAttribute('role', 'status'); this.el.append(this.status)
    const actions = this.el.querySelector('.local-actions')!
    this.arm = document.createElement('button'); this.arm.type = 'button'; this.arm.className = 'kit-action'
    this.arm.onclick = () => { if (input.armed) input.disarm(); else { input.clear(); input.armed = true; opts.canvas.focus({ preventScroll: true }) }; this.paint() }
    actions.append(this.arm)
    const button = (icon: string, label: string, run: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'kit-action'; localAction(b, icon, label); b.onclick = run; actions.append(b); return b }
    button('help', 'Bindings', () => this.toggleHelp())
    const lock = button('mouse', 'Lock mouse · Esc releases', () => { if (input.source === 'keyboard' && input.armed) { opts.canvas.focus(); void opts.canvas.requestPointerLock()?.catch(() => { this.status.textContent = 'Mouse lock unavailable · drag to aim' }) } })
    lock.hidden = !opts.canvas.requestPointerLock
    this.help.className = 'local-bindings glass'; this.help.hidden = true; this.help.setAttribute('role', 'region'); this.help.setAttribute('aria-label', 'Control bindings'); document.body.append(this.help)
    this.help.addEventListener('keydown', e => { if (e.key === 'Escape') { this.help.hidden = true; this.remap = null; opts.canvas.focus(); e.stopPropagation() } })
    const panel = simPanels().add(this.el, { id: 'local-control', title: 'Play on this device', purpose: 'Choose a controller and its bindings', icon: 'play', anchor: 'controls', state: 'closed' })
    installLocalInputSource(mode => {
      input.disarm()
      if (mode === 'touch') input.source = 'touch'
      else if (mode !== 'choose') { if (!['keyboard', 'gamepad'].includes(input.source)) input.source = 'keyboard'; input.armed = true }
      this.save(); this.paint(); panel.setState('open')
      // Share closes its modal after the launch event, so focus on the next frame.
      requestAnimationFrame(() => { if (input.armed) opts.canvas.focus({ preventScroll: true }) })
      return () => { input.disarm(); this.paint() }
    }, () => opts.units()[input.unit]?.id)
    addEventListener('obpal:localunit', e => { const n = opts.units().findIndex(u => u.id === (e as CustomEvent<string>).detail); if (n >= 0) { input.selectUnit(n); this.save(); this.paint() } })
    opts.canvas.tabIndex = 0
    opts.canvas.setAttribute('aria-description', 'Enable local controls, then focus this scene to play. Tab leaves the scene. Question mark shows bindings; Escape releases controls.')
    const abort = new AbortController(), signal = abort.signal
    const clear = () => { input.disarm(); this.pointer = null; this.paint() }
    const keyboard = (e: KeyboardEvent) => {
      if (this.remap && e.type === 'keydown') {
        if (e.code === 'Escape') this.remap = null
        else if (/^(Key[A-Z]|Digit[1-9]|Arrow(Up|Down|Left|Right)|Space|Enter|Shift(Left|Right))$/.test(e.code)) { input.bindings[this.remap] = [e.code]; this.remap = null; this.save() }
        else return
        e.preventDefault(); e.stopImmediatePropagation(); this.paintHelp(); return
      }
      if (editable(e.target) || e.altKey || e.ctrlKey || e.metaKey) return
      if (e.code === 'Escape') { clear(); if (document.pointerLockElement === opts.canvas) document.exitPointerLock(); return }
      if (e.key === '?' && e.type === 'keydown' && !e.repeat && document.activeElement === opts.canvas) { this.toggleHelp(); e.preventDefault(); e.stopImmediatePropagation(); return }
      if (!input.armed || input.source !== 'keyboard' || document.activeElement !== opts.canvas) return
      const used = Object.values(input.bindings).some(codes => codes.includes(e.code)) || /^Digit[1-9]$/.test(e.code)
      if (!used) return
      input.key(e.code, e.type === 'keydown'); e.preventDefault(); e.stopImmediatePropagation()
    }
    addEventListener('keydown', keyboard, { capture: true, signal }); addEventListener('keyup', keyboard, { capture: true, signal })
    addEventListener('blur', clear, { signal })
    document.addEventListener('visibilitychange', () => { if (document.hidden) clear() }, { signal })
    document.addEventListener('focusin', e => { if (e.target !== opts.canvas) input.clear() }, { signal })
    document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) input.clear() }, { signal })
    opts.canvas.addEventListener('pointerdown', e => {
      if (!input.armed || input.source !== 'keyboard') return
      this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' }
      input.dragging = true; opts.canvas.focus(); opts.canvas.setPointerCapture(e.pointerId)
      e.preventDefault(); e.stopImmediatePropagation()
    }, { capture: true, signal })
    opts.canvas.addEventListener('pointermove', e => {
      if (!input.armed || input.source !== 'keyboard') return
      if (document.pointerLockElement === opts.canvas) input.move(e.movementX, e.movementY)
      else if (this.pointer?.id === e.pointerId) {
        if (this.pointer.touch) input.touchStick((e.clientX - this.pointer.x) / 70, (e.clientY - this.pointer.y) / 70)
        else { input.move(e.clientX - this.pointer.x, e.clientY - this.pointer.y); this.pointer.x = e.clientX; this.pointer.y = e.clientY }
      } else return
      e.preventDefault(); e.stopImmediatePropagation()
    }, { capture: true, signal })
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) opts.canvas.addEventListener(type, () => { this.pointer = null; input.dragging = false; input.releaseTouch() }, { signal })
    opts.canvas.addEventListener('wheel', e => { if (input.armed && input.source === 'keyboard' && document.activeElement === opts.canvas) { input.scroll(e.deltaY); e.preventDefault(); e.stopImmediatePropagation() } }, { capture: true, passive: false, signal })
    addEventListener('pagehide', () => { this.stopped = true; clear(); abort.abort() }, { once: true })
    this.paint()
  }
  private save() { try { localStorage.setItem(`obpal.local:${this.opts.id}`, JSON.stringify({ source: this.input.source, unit: this.input.unit, bindings: this.input.bindings })) } catch { /* Storage is optional. */ } }
  private toggleHelp() { this.help.hidden = !this.help.hidden; this.paintHelp() }
  private paintHelp() {
    this.help.replaceChildren()
    const close = document.createElement('button'); close.type = 'button'; close.className = 'kit-action'; iconAction(close, 'close', 'Close bindings'); close.onclick = () => { this.help.hidden = true; this.remap = null; this.opts.canvas.focus() }; this.help.append(close)
    if (this.input.source === 'gamepad') {
      for (const [keys, name] of [['LS', 'Move / tilt'], ['RS', 'Aim / turn'], ['LT RT', 'Lower / rise'], ['A B X Y', 'Actions'], ['D-pad', 'Nudge'], ['Guide', 'Home']]) { const row = document.createElement('span'); row.className = 'local-binding'; setMarkup(row, html`<kbd>${keys}</kbd><span>${name}</span>`); this.help.append(row) }
    }
    const rows: [string, string][] = this.input.source === 'gamepad' ? [] : [['forward', 'Forward'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['turnLeft', 'Turn left'], ['turnRight', 'Turn right'], ['lookUp', 'Aim up'], ['lookDown', 'Aim down'], ['lookLeft', 'Aim left'], ['lookRight', 'Aim right'], ['rise', 'Rise / RT'], ['lower', 'Lower / LT'], ['primary', 'Primary / A'], ['secondary', 'Secondary / B'], ['third', 'X'], ['fourth', 'Y'], ['home', 'Home']]
    if (this.opts.hardware?.()) rows.push(['deadman', 'Hold to drive · LB'])
    for (const [id, label] of rows) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'kit-action local-binding'; b.setAttribute('aria-label', `Remap ${label}`)
      setMarkup(b, html`<span>${label}</span>${[...new Set(this.input.bindings[id].map(cap))].map(key => html`<kbd>${key}</kbd>`)}`)
      b.onclick = () => { this.input.clear(); this.remap = id; b.textContent = 'Press a key · Esc cancels' }; this.help.append(b)
    }
    for (const [n, action] of (this.opts.tray ?? []).entries()) {
      if (n >= 9 || action.type !== 'button') continue
      const b = document.createElement('button'); b.type = 'button'; b.className = 'kit-action local-binding'; b.dataset.action = action.id
      setMarkup(b, html`<span>${action.label}</span><kbd>${n + 1}</kbd>`); b.onclick = () => this.input.press(action.id); this.help.append(b)
    }
    const hint = document.createElement('span'); hint.className = 'local-binding-hint'; setMarkup(hint, html`${ICONS.mouse}<span>Drag · move / aim</span><kbd>Wheel</kbd><span>Zoom / value</span><kbd>?</kbd><kbd>Esc</kbd><kbd>Tab</kbd>`); this.help.append(hint)
  }
  private paint() {
    const { input } = this
    this.el.querySelectorAll<HTMLButtonElement>('[data-source]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === input.source)))
    const units = this.opts.units(), signature = units.map(u => u.id).join('|')
    if (this.select.dataset.units !== signature) { this.select.dataset.units = signature; this.select.replaceChildren(...units.map((u, n) => { const o = document.createElement('option'); o.value = String(n); o.textContent = u.name; return o })) }
    this.select.value = String(input.unit)
    localAction(this.arm, input.armed ? 'stop' : 'play', input.armed ? 'Release local controls' : 'Enable local controls')
    this.arm.setAttribute('aria-pressed', String(input.armed)); this.arm.hidden = !['keyboard', 'gamepad'].includes(input.source)
    this.opts.orbit?.(!(input.armed && input.source === 'keyboard'))
    if (!this.help.hidden) this.paintHelp()
    this.opts.changed?.()
  }
  /** A claimed phone is authoritative even while its watchdog holds the unit at rest. */
  frames(claimed: (unit: number) => boolean, dt: number): Map<number, DeviceInput> {
    if (this.stopped) return new Map()
    if (this.select.dataset.units !== this.opts.units().map(u => u.id).join('|')) {
      if (this.input.unit >= this.opts.units().length) this.input.selectUnit(0)
      this.paint()
    }
    let pads: (Gamepad | null)[] = []
    try { pads = [...(navigator.getGamepads?.() ?? [])] } catch { /* API permission may be refused. */ }
    const detected = pads.some(p => p && standardPad(p))
    this.padChoice.hidden = !detected
    if (this.input.source === 'gamepad' && !detected && this.input.armed) { this.input.disarm(); this.paint() }
    if (claimed(this.input.unit) && this.input.armed && this.input.source !== 'gamepad') { this.input.disarm(); this.paint() }
    const usable = !document.hidden && !editable(document.activeElement) && (this.input.source !== 'keyboard' || document.activeElement === this.opts.canvas)
    const frames = this.input.read(pads, usable)
    const hardware = !!this.opts.hardware?.()
    if (hardware !== this.lastHardware) { this.lastHardware = hardware; if (!this.help.hidden) this.paintHelp() }
    for (const [n, i] of frames) {
      if (claimed(n)) { frames.delete(n); continue }
      frames.set(n, liveInput(i, hardware, this.input.bindings.deadman.some(code => this.input.keys.has(code)) || !!(i.pad && i.pad.buttons & (1 << 4))))
    }
    const deadman = hardware ? ` · hold ${this.input.source === 'gamepad' ? 'LB' : this.input.bindings.deadman.map(cap).join('/')} to drive` : ''
    const text = claimed(this.input.unit) ? 'Phone active on selected unit · local input paused' : this.input.armed ? `${this.input.source === 'gamepad' ? 'Gamepad' : 'Keyboard, mouse and touch'} active${deadman}` : this.input.source === 'gamepad' ? detected ? 'Gamepad detected · enable, then press any button' : 'Connect a standard gamepad and press any button' : 'Local controls released · enable to play'
    if (text !== this.lastStatus) { this.status.textContent = text; this.lastStatus = text }
    void dt
    return frames
  }
}
