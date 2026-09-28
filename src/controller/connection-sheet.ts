/** The phone's private list and scanner, built with DOM text under the controller's Trusted Types policy. */
import { formatCode, lookupCode, splitCode, type StoredConnection } from '@obpal/core'
import { Connections, type Join } from './connections'
import { Scanner } from './scanner'
import { readScan } from './scan-code'
import { sheetExits } from './sheet'
import { tick } from './haptics'
import { ICONS } from '../ui/icons'
import { html, setMarkup } from '../ui/markup'

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') {
  const node = document.createElement(tag)
  node.className = cls
  node.textContent = text
  return node
}
const button = (text: string, run: () => void, cls = 'btn') => {
  const b = h('button', cls, text)
  b.type = 'button'
  b.onclick = run
  return b
}
const kinds = { pc: 'PC', sim: 'Sim', viewer: 'Viewer', site: 'Site' }
const ago = (at: number) => {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000))
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export class ConnectionSheet {
  private dialog: HTMLDialogElement | null = null
  private body: HTMLElement | null = null
  private scanner: Scanner | null = null
  private exits = () => {}
  private view: 'list' | 'scan' | 'code' = 'list'
  private busy = false
  private until = 0
  private generation = 0
  private signature = ''
  private returnFocus: HTMLElement | null = null
  private say: HTMLElement | null = null

  constructor(private hub: Connections) {
    hub.changed = () => { if (this.dialog && this.view === 'list') this.list() }
    addEventListener('pagehide', () => this.close())
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.view === 'scan') this.close() })
  }

  open(scan = false) {
    if (!this.dialog) {
      this.returnFocus = document.activeElement as HTMLElement | null
      const dialog = h('dialog', 'sheet-wrap connection-wrap')
      const card = h('section', 'sheet connection-sheet glass')
      card.setAttribute('aria-label', 'Connections')
      const head = h('div', 'sheet-head connection-head')
      head.append(h('div', 'grip'), h('h2', '', 'Connections'))
      const close = button('×', () => this.close(), 'icon-btn glass')
      close.setAttribute('aria-label', 'Close connections')
      head.append(close)
      this.body = h('div', 'connection-body')
      this.say = h('p', 'connection-say')
      this.say.setAttribute('role', 'status')
      card.append(head, this.body, this.say)
      dialog.append(card)
      document.body.append(dialog)
      this.dialog = dialog
      dialog.setAttribute('aria-label', 'Connections')
      dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.close() })
      dialog.showModal()
      this.hub.suspend(true)
      this.exits = sheetExits(dialog, () => this.close())
    }
    this.view = scan ? 'scan' : 'list'
    if (scan) this.scan()
    else { this.signature = ''; this.list() }
  }

  close() {
    if (!this.dialog) return
    ++this.generation
    this.scanner?.stop()
    this.scanner = null
    this.busy = false
    this.exits()
    this.dialog.close()
    this.dialog.remove()
    this.dialog = null
    this.body = null
    this.hub.suspend(false)
    if (this.returnFocus?.isConnected) this.returnFocus.focus()
  }

  private tell(s: string) { if (this.say) this.say.textContent = s }

  private list() {
    if (!this.body) return
    this.dialog!.querySelector('h2')!.textContent = 'Connections'
    const all = new Map(this.hub.rows)
    for (const c of this.hub.live.values()) if (!all.has(c.row.id)) all.set(c.row.id, c.row)
    const rows = [...all.values()].sort((a, b) => (Number(b.id === this.hub.current) - Number(a.id === this.hub.current)) || Number(!!this.hub.live.get(b.id)?.link.ready) - Number(!!this.hub.live.get(a.id)?.link.ready) || b.at - a.at)
    const signature = JSON.stringify([this.hub.current, this.hub.maxLive, rows.map((r) => [r.id, r.name, r.at, this.hub.live.get(r.id)?.link.status, this.hub.live.get(r.id)?.stats?.path])])
    if (signature === this.signature) return
    this.signature = signature
    const list = h('div', 'connection-list')
    list.setAttribute('role', 'list')
    for (const row of rows) list.append(this.entry(row))
    if (!rows.length) list.append(h('p', 'connection-empty', 'Your screens will appear here.'))
    const tools = h('div', 'connection-actions')
    tools.append(button('Scan a code', () => this.scan(), 'btn primary'), button('Enter a code', () => this.code()))
    const limit = h('label', 'connection-limit', 'Keep connected')
    const select = h('select')
    select.setAttribute('aria-label', 'Maximum live connections')
    for (let n = 1; n <= 4; n++) { const o = h('option', '', String(n)); o.value = String(n); select.append(o) }
    select.value = String(this.hub.maxLive)
    select.onchange = () => {
      this.hub.setLimit(Number(select.value))
      try { localStorage.setItem('obpal.connections.limit', select.value) } catch { /* session only */ }
    }
    limit.append(select)
    this.body.replaceChildren(list, tools, limit)
  }

  private entry(row: StoredConnection) {
    const c = this.hub.live.get(row.id)
    const active = row.id === this.hub.current
    const live = !!c?.link.ready
    const connecting = c && ['signaling', 'connecting', 'securing', 'reconnecting'].includes(c.link.status)
    const el = h('div', 'connection-row')
    el.dataset.connection = row.id
    el.dataset.active = String(active)
    el.setAttribute('role', 'listitem')
    const use = button('', () => {
      if (!live && !row.invite) { this.scan(); this.tell('Scan this screen’s current code to reconnect.'); return }
      tick()
      void this.hub.use(row.id).then(() => this.close(), (e: Error) => this.tell(e.message))
    }, 'connection-use')
    use.setAttribute('aria-label', `${active ? 'Active' : 'Switch to'} ${row.name}`)
    const mark = h('span', 'connection-mark', active ? '●' : live ? 'Ⅱ' : '○')
    mark.setAttribute('aria-hidden', 'true')
    const label = h('span', 'connection-label')
    label.append(h('b', '', row.name), h('small', '', `${kinds[row.kind]} · ${active && live ? 'Connected' : live ? 'Available · paused' : connecting ? 'Connecting…' : 'Offline'}`))
    const detail = h('span', 'connection-detail')
    const badge = h('small', 'connection-badge', 'Not connected')
    if (live) setMarkup(badge, html`${ICONS.lock}<span>${c?.stats?.path === 'relay' ? 'Relayed' : c?.stats?.path === 'direct' ? 'Direct' : 'Encrypted'}</span>`)
    detail.append(h('small', '', ago(row.at)), badge)
    use.append(mark, label, detail)
    const manage = h('div', 'connection-manage')
    manage.append(button('Rename', () => {
      const form = h('form', 'connection-rename')
      const input = h('input')
      input.value = row.name
      input.maxLength = 80
      input.setAttribute('aria-label', 'Screen name')
      const save = button('Save', () => {})
      save.type = 'submit'
      form.append(input, save, button('Cancel', () => { this.signature = ''; this.list() }))
      form.onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) { this.signature = ''; this.hub.rename(row.id, input.value) } }
      manage.replaceChildren(form)
      input.focus(); input.select()
    }, 'connection-option'), button('Forget', () => {
      void this.hub.forget(row.id).then(() => { this.signature = ''; this.list(); this.tell('Forgotten. Scan again to reconnect.') })
    }, 'connection-option'))
    el.append(use, manage)
    return el
  }

  private scan() {
    if (!this.body) return
    ++this.generation
    this.scanner?.stop()
    this.view = 'scan'
    this.dialog!.querySelector('h2')!.textContent = 'Scan a code'
    this.signature = ''
    this.busy = false
    const frame = h('div', 'scan-frame')
    const video = h('video')
    video.setAttribute('aria-label', 'Camera preview')
    frame.append(video, h('div', 'scan-guide'))
    const torch = button('Torch', () => {})
    torch.setAttribute('aria-label', 'Toggle torch')
    const actions = h('div', 'connection-actions')
    actions.append(torch, button('Enter a code', () => this.code()), button('Connections', () => { this.scanner?.stop(); this.view = 'list'; this.tell(''); this.list() }))
    this.body.replaceChildren(frame, actions)
    this.scanner = new Scanner(video, torch, (s) => this.tell(s), (text) => {
      const result = readScan(text, location.origin)
      if (!result) { tick(true); this.tell('That isn’t an ob.Pal code for this site.'); return }
      this.scanner?.stop()
      tick()
      if (result.kind === 'short') { this.code(result.digits); void this.short(result.digits) }
      else void this.join(result.code)
    })
    void this.scanner.start()
  }

  private code(digits = '') {
    if (!this.body) return
    ++this.generation
    this.scanner?.stop()
    this.view = 'code'
    this.dialog!.querySelector('h2')!.textContent = 'Enter a code'
    this.busy = false
    this.tell('Type the ten digits shown beside the QR code.')
    const form = h('form', 'code-form')
    const input = h('input', 'code-in')
    input.setAttribute('aria-label', 'Code from your screen')
    input.inputMode = 'numeric'
    input.autocomplete = 'off'
    input.maxLength = 16
    input.placeholder = '000 000 0000'
    input.value = formatCode(digits)
    const go = button('Connect', () => {}, 'btn primary')
    go.type = 'submit'
    form.append(input, go, button('Scan instead', () => this.scan()))
    form.onsubmit = (e) => { e.preventDefault(); void this.short(input.value) }
    this.body.replaceChildren(form)
    input.focus()
  }

  private async short(text: string) {
    if (this.busy) return
    if (Date.now() < this.until) { this.tell('Too many tries. Wait a moment, then try again.'); return }
    const parsed = readScan(text, location.origin)
    const parts = parsed?.kind === 'short' ? splitCode(parsed.digits) : null
    if (!parts) { this.tell('Enter all ten digits, starting with 1–9.'); return }
    this.busy = true
    this.tell('Finding your screen…')
    const generation = this.generation
    const result = await lookupCode(location.origin, parts.handle)
    if (generation !== this.generation || !this.dialog) return
    this.busy = false
    if ('room' in result) await this.join({ v: 'code', code: { ...parts, room: result.room, ticket: result.ticket } })
    else {
      if (result.error === 'slow-down') this.until = Date.now() + (result.retry ?? 60) * 1000
      this.tell(result.error === 'no-code' ? 'No screen shows that code. Each code works once.' : result.error === 'slow-down' ? 'Too many tries. Wait a moment, then try again.' : 'Could not reach ob.Pal. Try again.')
    }
  }

  private async join(join: Join) {
    const generation = this.generation
    try { await this.hub.connect(join); if (generation === this.generation) this.close() }
    catch (e) { this.tell(e instanceof Error ? e.message : 'Could not connect. Try again.') }
  }
}
