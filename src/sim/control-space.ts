/**
 * Per-controller scope and motion freshness. Claims and permission remain owned by the scene. The screen shows, for the
 * phone it's configuring, the scope as a segmented control (Object or Scene) and Set position.
 */
import type { Remote } from '@obpal/host'
import { CONTROL_SPACES, readControlAim, type ControlAim, type ControlScope } from '../control-space'
import { Segmented } from '../ui/kit/segmented'
import { ICONS } from '../ui/icons'
import { html, setMarkup } from '../ui/markup'
import '../styles/control-space.css'

export class ControlSession {
  private scopes = new Map<string, ControlScope>()
  private samples = new Map<string, { value: ControlAim; at: number }>()
  private serial = 0
  private clients = new Set<string>()
  private positioning = new Set<string>()
  private targets = new Map<string, string>()
  private selected = ''
  /** The row's controls, kept between draws so focus and the glass select stay put. */
  private ui: { select: HTMLSelectElement; scope: Segmented; position: HTMLButtonElement } | null = null
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
    // A panel may keep a place for these (the device panel's Controllers section). Managed windows come after the People
    // sheet in the DOM; the controls still belong in the main card.
    const parent = document.querySelector('[data-scope-home]') ?? document.querySelector('.dev-panel, .sim-panel') ?? document.querySelector('#panel, #people')
    if (!parent) return
    let row = parent.querySelector<HTMLElement>('.control-scopes')
    if (!row) {
      row = document.createElement('div'); row.className = 'control-scopes'
      // Before the unit list while it's still in the card, at the end otherwise.
      parent.insertBefore(row, parent.querySelector(':scope > :is(#dev-units, #arms, #people-list)'))
    }
    const people = this.remote.participants.filter(p => p.caps?.platform !== 'scene')
    row.hidden = !people.length
    if (!people.some(p => p.id === this.selected)) this.selected = people[0]?.id ?? ''
    const p = people.find(p => p.id === this.selected)
    if (!p) { row.replaceChildren(); this.ui = null; return }
    if (!this.ui || !row.contains(this.ui.position)) this.ui = this.build(row)
    const { select, scope, position } = this.ui
    select.replaceChildren(...people.map(person => { const option = document.createElement('option'); option.value = person.id; option.textContent = person.name; return option }))
    select.value = p.id; select.hidden = people.length < 2
    scope.value = this.scope(p.id); scope.el.setAttribute('aria-label', `Control scope for ${p.name}`)
    position.onclick = () => this.position(p.id)
  }
  private build(row: HTMLElement) {
    const select = document.createElement('select')
    select.setAttribute('aria-label', 'Phone to configure')
    select.onchange = () => { this.selected = select.value; this.draw() }
    const scope = new Segmented({
      label: 'Control scope', value: 'object', className: 'control-scope',
      items: [{ value: 'object', label: 'Object', icon: ICONS.cube }, { value: 'scene', label: 'Scene', icon: ICONS.orbit }],
      onChange: v => { if (this.selected) this.setScope(this.selected, v as ControlScope) },
    })
    const position = document.createElement('button'); position.type = 'button'; position.className = 'kit-action'
    setMarkup(position, html`${ICONS.center}<span>Set position</span>`)
    const group = document.createElement('div'); group.append(scope.el, position)
    row.replaceChildren(select, group)
    return { select, scope, position }
  }
}
