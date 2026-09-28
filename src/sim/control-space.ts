/** Per-controller scope and motion freshness. Claims and permission remain owned by the scene. */
import type { Remote } from '@obpal/host'
import { CONTROL_SPACES, readControlAim, type ControlAim, type ControlScope } from '../control-space'
import '../styles/control-space.css'

export class ControlSession {
  private scopes = new Map<string, ControlScope>()
  private samples = new Map<string, { value: ControlAim; at: number }>()
  private serial = 0
  private clients = new Set<string>()
  private positioning = new Set<string>()
  private targets = new Map<string, string>()
  private selected = ''
  constructor(readonly remote: Remote, readonly id: string) {
    remote.setValues({ 'control.sim': id, 'control.scope': 'object' })
    remote.on('value', ({ id, v }, who) => {
      if (id === 'control.scope' && (v === 'object' || v === 'scene')) this.setScope(who.id, v)
      if (id === 'control.aim') {
        const value = readControlAim(v)
        if (value) {
          this.clients.add(who.id)
          if (!this.positioning.has(who.id)) this.samples.set(who.id, { value, at: performance.now() })
        }
      }
    })
    remote.on('recenter', who => {
      this.positioning.delete(who.id)
      const previous = this.samples.get(who.id)
      if (previous) this.samples.set(who.id, { value: { aim: [0, 0], tilt: [0, 0], active: previous.value.active }, at: performance.now() })
    })
    remote.on('mode', (_mode, who) => this.samples.delete(who.id))
    remote.on('leave', who => { this.scopes.delete(who.id); this.samples.delete(who.id); this.clients.delete(who.id); this.positioning.delete(who.id); this.targets.delete(who.id); this.draw() })
    remote.on('join', () => this.draw())
    this.draw()
  }
  scope(who: string): ControlScope { return this.scopes.get(who) ?? 'object' }
  calibrated(who: string) { return this.clients.has(who) }
  awaitingPosition(who: string) { return this.positioning.has(who) }
  aim(who: string, now = performance.now()): ControlAim | null {
    const s = this.samples.get(who)
    return s && s.value.active && now - s.at < 300 ? s.value : null
  }
  setScope(who: string, scope: ControlScope) {
    this.scopes.set(who, scope)
    this.samples.delete(who)
    this.remote.setValues({ 'control.scope': scope }, who)
    this.draw()
  }
  target(who: string, name: string) {
    if (this.targets.get(who) === name) return
    this.targets.set(who, name)
    this.remote.setValues({ 'control.target': name }, who)
  }
  /** Claiming a new object captures the current phone pose, without resetting the object. */
  position(who: string) {
    this.samples.delete(who)
    if (this.calibrated(who)) this.positioning.add(who)
    this.remote.setValues({ 'control.position': ++this.serial }, who)
  }
  private draw() {
    if (!CONTROL_SPACES[this.id]) return
    const parent = document.querySelector('.dev-panel, .sim-panel, #panel, #people')
    if (!parent) return
    let row = parent.querySelector<HTMLElement>('.control-scopes')
    if (!row) {
      row = document.createElement('div'); row.className = 'control-scopes'
      parent.insertBefore(row, parent.querySelector('#dev-units, #arms, #people-list'))
    }
    const people = this.remote.participants.filter(p => p.caps?.platform !== 'scene')
    row.hidden = !people.length
    if (!people.some(p => p.id === this.selected)) this.selected = people[0]?.id ?? ''
    const p = people.find(p => p.id === this.selected)
    row.replaceChildren()
    if (p) {
      const select = document.createElement('select')
      select.setAttribute('aria-label', 'Phone to configure'); select.hidden = people.length < 2
      select.replaceChildren(...people.map(person => { const option = document.createElement('option'); option.value = person.id; option.textContent = person.name; return option }))
      select.value = p.id; select.onchange = () => { this.selected = select.value; this.draw() }
      const group = document.createElement('div'), scope = document.createElement('button'), position = document.createElement('button')
      scope.type = position.type = 'button'; scope.className = position.className = 'btn'
      scope.textContent = this.scope(p.id) === 'scene' ? 'Scene scope' : 'Object scope'
      scope.setAttribute('aria-label', `Control scope for ${p.name}`)
      scope.setAttribute('aria-pressed', String(this.scope(p.id) === 'scene'))
      scope.onclick = () => this.setScope(p.id, this.scope(p.id) === 'scene' ? 'object' : 'scene')
      position.textContent = 'Set position'; position.onclick = () => this.position(p.id)
      group.append(scope, position); row.append(select, group)
    }
  }
}
