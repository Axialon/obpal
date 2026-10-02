import { presenceStrip, type AudienceState, type RoomState } from '../sim/participation'
import { iconAction } from './kit/action'
import { fitControlInk } from './kit/ink'
import { enhanceSelect } from './kit/select'
import { ICONS } from './icons'
import { setMarkup } from './markup'
import '../styles/participants.css'

export interface ParticipantActions {
  handover(op: string, to?: string): void
  audience(data: { op: 'join' | 'leave' } | { x: number; y: number }): void
  configure?(mode: AudienceState['mode'], unit: string, seconds: number): void
  stream?(): void
  share?(): void
}

/** A shared dot language for the screen, scene visitors and controller phones. */
export class ParticipantStrip {
  readonly root = document.createElement('aside')
  private row = document.createElement('div')
  private actions = document.createElement('div')
  private requests = document.createElement('div')
  private audience = document.createElement('div')
  private queue = document.createElement('span')
  private field = document.createElement('div')
  private join: HTMLButtonElement
  private stick = document.createElement('div')
  private menu = document.createElement('details')
  private state: RoomState | null = null
  private signature = ''
  private direction: [number, number] = [0, 0]
  private voting = false
  private timer: ReturnType<typeof setInterval>
  constructor(private callbacks: ParticipantActions, private host = false, compact = false) {
    this.root.className = `participant-strip glass${host ? ' participant-host' : ''}${compact ? ' participant-phone' : ''}`; this.root.setAttribute('aria-label', 'Who is here'); this.root.hidden = true
    this.row.className = 'participant-row'; this.row.setAttribute('role', 'list'); this.actions.className = 'participant-actions'; this.requests.className = 'participant-requests'
    this.audience.className = 'audience-overlay'; this.queue.className = 'audience-queue'; this.queue.setAttribute('role', 'status')
    this.field.className = 'audience-votes'; this.field.setAttribute('aria-label', 'Individual crowd directions')
    this.join = this.button('Join queue', () => callbacks.audience({ op: this.state?.audience.next.includes(this.state.you) || this.state?.audience.turn === this.state?.you ? 'leave' : 'join' }))
    this.stick.className = 'audience-stick'; this.stick.setAttribute('role', 'group'); this.stick.setAttribute('aria-label', 'Audience direction'); this.stick.tabIndex = 0
    const dot = document.createElement('i'); this.stick.append(dot)
    let pointer: number | null = null
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return
      const r = this.stick.getBoundingClientRect(), x = (e.clientX - r.x - r.width / 2) / (r.width * .4), y = (e.clientY - r.y - r.height / 2) / (r.height * .4), scale = Math.max(1, Math.hypot(x, y))
      this.direction = [x / scale, y / scale]; dot.style.transform = `translate(${this.direction[0] * 20}px, ${this.direction[1] * 20}px)`
    }
    this.stick.onpointerdown = e => { if (pointer !== null) return; this.voting = true; pointer = e.pointerId; this.stick.setPointerCapture(pointer); move(e) }
    this.stick.onpointermove = move
    const release = () => { pointer = null; this.release(); dot.style.transform = '' }
    this.stick.onpointerup = release; this.stick.onpointercancel = release; this.stick.onlostpointercapture = release; this.stick.onblur = release
    this.stick.onkeydown = e => {
      const keys: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
      if (keys[e.key]) { e.preventDefault(); this.voting = true; this.direction = keys[e.key] }
    }
    this.stick.onkeyup = release
    this.audience.append(this.queue, this.field, this.join, this.stick)
    this.root.append(this.row, this.actions, this.requests, this.audience, this.menu)
    document.body.append(this.root); fitControlInk(this.root)
    this.timer = setInterval(() => { if (this.voting && this.canVote() && !document.hidden) callbacks.audience({ x: this.direction[0], y: this.direction[1] }) }, 50)
    addEventListener('blur', this.release); document.addEventListener('visibilitychange', this.hidden)
    addEventListener('pagehide', () => this.destroy(), { once: true })
  }
  private button(label: string, action: () => void, glyph?: string) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'participant-action'; if (glyph) iconAction(b, glyph, label); else b.textContent = label; b.onclick = action; return b
  }
  private canVote() { const s = this.state, person = s?.people.find(p => p.id === s.you); return !!s && person?.role === 'watch' && (s.audience.mode === 'crowd' || s.audience.mode === 'queue' && s.audience.turn === s.you) }
  private release = () => { this.voting = false; this.direction = [0, 0]; if (this.canVote()) this.callbacks.audience({ x: 0, y: 0 }) }
  private hidden = () => { if (document.hidden) this.release() }
  update(state: RoomState) {
    this.root.hidden = false
    const couldVote = this.canVote(); this.state = state; if (couldVote && !this.canVote()) { this.voting = false; this.direction = [0, 0] }
    const signature = JSON.stringify([state.people, state.requests, state.units])
    if (signature !== this.signature) { this.signature = signature; this.renderPeople() }
    const a = state.audience, name = (id: string | null) => state.people.find(p => p.id === id)?.name || 'Guest', unit = state.units.find(u => u.id === a.unit)?.name ?? 'Audience'
    const mode = this.menu.querySelector<HTMLSelectElement>('select[aria-label="Audience mode"]'); if (mode && mode.value !== a.mode) mode.value = a.mode
    this.audience.hidden = a.mode === 'off'
    this.queue.textContent = a.mode === 'queue' ? `${unit} · ${a.turn ? `${name(a.turn)} · ${a.remaining}s` : 'Queue open'}${a.next.length ? ` · Next ${name(a.next[0])}${a.next.length > 1 ? ` +${a.next.length - 1}` : ''}` : ''}` : `${unit} · Crowd · ${a.votes.length}`
    const watcher = state.people.find(p => p.id === state.you)?.role === 'watch'
    this.join.hidden = this.host || !watcher || a.mode !== 'queue'; this.join.textContent = a.turn === state.you || a.next.includes(state.you) ? 'Leave queue' : 'Join queue'
    this.stick.hidden = !this.canVote()
    this.field.hidden = a.mode !== 'crowd'
    this.field.replaceChildren(...a.votes.map(v => { const dot = document.createElement('i'); dot.style.left = `${50 + v.x * 40}%`; dot.style.top = `${50 + v.y * 40}%`; dot.dataset.accepted = String(v.accepted); dot.title = `${name(v.id)}${v.accepted ? '' : ' · outlier'}`; return dot }), (() => { const merged = document.createElement('b'); merged.style.left = `${50 + a.direction[0] * 40}%`; merged.style.top = `${50 + a.direction[1] * 40}%`; merged.title = 'Merged direction'; return merged })())
    if (this.host) {
      const strip = this.root.getBoundingClientRect(), panels = [...document.querySelectorAll<HTMLElement>('#people, .stopped-banner, .presence-floating'), ...(document.querySelector('.obpal-chip')?.shadowRoot?.querySelectorAll<HTMLElement>('.pill, .card') ?? [])], cards = panels.filter(el => el.checkVisibility()).map(el => el.getBoundingClientRect()).filter(r => r.width && r.top < 180 && r.left < strip.right && r.right > strip.left)
      if (cards.length) this.root.style.setProperty('--participant-top', `${Math.max(...cards.map(r => r.bottom)) + 8}px`)
      else this.root.style.removeProperty('--participant-top')
      if (document.querySelector('.node-card')) {
        const bottom = `${this.root.getBoundingClientRect().bottom + 8}px`
        if (document.body.style.getPropertyValue('--viewer-presence-bottom') !== bottom) document.body.style.setProperty('--viewer-presence-bottom', bottom)
      }
    }
  }
  private renderPeople() {
    const s = this.state!, strip = presenceStrip(s.people.filter(p => p.id !== 'host'))
    this.row.setAttribute('aria-label', `${strip.players.length} players, ${strip.watcherCount} watchers`)
    this.row.replaceChildren(...[...strip.players, ...strip.watchers].map(p => {
      const item = document.createElement('span'); item.className = 'participant'; item.dataset.role = p.role; item.style.setProperty('--participant-color', p.color)
      if (p.seat) item.dataset.seat = p.seat
      const dot = document.createElement('i'); dot.className = 'participant-dot'; dot.setAttribute('aria-hidden', 'true')
      const label = document.createElement('span'); label.textContent = `${p.name || 'Guest'}${p.seat ? ` · ${p.seat}` : ''}`
      item.title = `${p.name || 'Guest'} · ${p.role === 'play' ? 'Playing' : 'Watching'}${p.seat ? ` · ${p.seat}` : ''}`; item.setAttribute('role', 'listitem'); item.setAttribute('aria-label', item.title); item.append(dot, label); return item
    }))
    const count = document.createElement('span'); count.className = 'watcher-count'; count.textContent = `${strip.watcherCount} watching`; this.row.append(count)
    const me = s.people.find(p => p.id === s.you), lead = !!me?.lead
    this.actions.replaceChildren()
    if (this.host && this.callbacks.share) { const share = this.button('Share scene', this.callbacks.share, 'share'); share.classList.add('participant-share'); this.actions.append(share) }
    if (!this.host && me?.role === 'watch') this.actions.append(this.button(s.requests.includes(s.you) ? 'Cancel request' : 'Ask to play', () => this.callbacks.handover(s.requests.includes(s.you) ? 'cancel' : 'ask')))
    if (me?.role === 'play' && s.people.some(p => p.role === 'watch')) {
      const give = document.createElement('select'); give.setAttribute('aria-label', 'Give to…'); const prompt = document.createElement('option'); prompt.value = ''; prompt.textContent = 'Give to…'; give.append(prompt)
      for (const p of s.people.filter(p => p.role === 'watch')) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name || 'Guest'; give.append(o) }
      give.onchange = () => { if (give.value) this.callbacks.handover('give', give.value); give.value = '' }; this.actions.append(give)
    }
    this.requests.replaceChildren()
    if (this.host || lead) for (const id of s.requests) {
      const row = document.createElement('div'); row.className = 'play-request'; const name = document.createElement('span'); name.textContent = s.people.find(p => p.id === id)?.name || 'Guest'
      row.append(name, this.button('Accept', () => this.callbacks.handover('accept', id)), this.button('Decline', () => this.callbacks.handover('decline', id))); this.requests.append(row)
    }
    this.menu.replaceChildren(); this.menu.hidden = !this.host
    if (this.host) {
      const summary = document.createElement('summary'); summary.className = 'kit-icon-action'; summary.setAttribute('aria-label', 'Audience & people'); summary.dataset.tip = 'Audience & people'; setMarkup(summary, ICONS.settings); this.menu.append(summary)
      const settings = document.createElement('div'); settings.className = 'participant-settings'
      const mode = document.createElement('select'); mode.setAttribute('aria-label', 'Audience mode')
      for (const id of ['off', 'queue', 'crowd'] as const) { const o = document.createElement('option'); o.value = id; o.textContent = id[0].toUpperCase() + id.slice(1); mode.append(o) }; mode.value = s.audience.mode
      const unit = document.createElement('select'); unit.setAttribute('aria-label', 'Audience model')
      for (const u of s.units) { const o = document.createElement('option'); o.value = u.id; o.textContent = u.name; o.disabled = !!u.busy && u.id !== s.audience.unit; unit.append(o) }; unit.value = s.audience.unit || s.units.find(u => !u.busy)?.id || ''
      const duration = document.createElement('input'); duration.type = 'number'; duration.min = '1'; duration.max = '300'; duration.value = String(s.audience.seconds); duration.setAttribute('aria-label', 'Turn seconds')
      const configure = () => this.callbacks.configure?.(mode.value as AudienceState['mode'], unit.value, Number(duration.value) || 60)
      mode.onchange = configure; unit.onchange = configure; duration.onchange = configure
      settings.append(mode, unit, duration)
      for (const p of s.people.filter(p => p.id !== 'host' && p.role === 'play')) settings.append(this.button(`Watch: ${p.name}`, () => this.callbacks.handover('demote', p.id)))
      if (this.callbacks.stream) settings.append(this.button('Stream view', this.callbacks.stream, 'view'))
      this.menu.append(settings)
    }
    for (const select of this.root.querySelectorAll('select')) { const glass = enhanceSelect(select); if (glass) glass.list.style.setProperty('--bb-z-menu', '100') }
  }
  destroy() { clearInterval(this.timer); removeEventListener('blur', this.release); document.removeEventListener('visibilitychange', this.hidden); this.root.remove() }
}
