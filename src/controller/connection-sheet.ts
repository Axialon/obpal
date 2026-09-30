/** The phone's private list and scanner, built with DOM text under the controller's Trusted Types policy. */
import { formatCode, lookupCode, splitCode, type StoredConnection } from '@obpal/core'
import { Connections, type Connection, type Join } from './connections'
import { pendingPhase, STILL_CONNECTING } from './pairing-recovery'
import { CameraView } from '../ui/camera'
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
  private scanner: CameraView | null = null
  private scanOnly = false
  private exits = () => {}
  private view: 'list' | 'scan' | 'code' | 'rename' = 'list'
  private busy = false
  private until = 0
  private generation = 0
  private signature = ''
  private returnFocus: HTMLElement | null = null
  private say: HTMLElement | null = null
  private background: { el: HTMLElement; hidden: string | null; inert: boolean } | null = null
  private joining: Connection | null = null

  constructor(private hub: Connections) {
    hub.changed = () => {
      if (this.joining?.welcome && !this.joining.failure && this.joining.link.ready && hub.active === this.joining) { this.close(); return }
      if (this.dialog && this.view === 'list') this.list()
    }
    addEventListener('pagehide', () => this.close())
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.view === 'scan') this.close() })
  }

  open(scan = false) {
    this.scanOnly = scan
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
      const app = document.getElementById('app')
      if (app) {
        this.background = { el: app, hidden: app.getAttribute('aria-hidden'), inert: app.inert }
        app.inert = true
        app.setAttribute('aria-hidden', 'true')
      }
      this.hub.suspend(true)
      this.exits = sheetExits(dialog, () => this.close())
    }
    this.view = scan ? 'scan' : 'list'
    if (scan) this.scan()
    else { this.stopCamera(); this.signature = ''; this.list() }
  }

  close() {
    if (!this.dialog) return
    ++this.generation
    this.stopCamera()
    this.busy = false
    this.joining = null
    this.exits()
    this.dialog.close()
    this.dialog.remove()
    this.dialog = null
    this.body = null
    if (this.background) {
      const { el, hidden, inert } = this.background
      el.inert = inert
      if (hidden === null) el.removeAttribute('aria-hidden')
      else el.setAttribute('aria-hidden', hidden)
      this.background = null
    }
    this.hub.suspend(false)
    const focus = this.returnFocus?.isConnected ? this.returnFocus : document.getElementById('code-in') ?? document.querySelector<HTMLElement>('.connection-title')
    focus?.focus()
  }

  enterCode(id?: string) {
    if (id) this.hub.cancel(id)
    this.open()
    this.code()
  }

  private tell(s: string) { if (this.say) this.say.textContent = s }

  private stopCamera() {
    const camera = this.scanner
    this.scanner = null
    camera?.close()
  }

  private list() {
    if (!this.body) return
    this.dialog!.querySelector('h2')!.textContent = 'Connections'
    const all = new Map(this.hub.rows)
    for (const c of this.hub.live.values()) if (!all.has(c.row.id)) all.set(c.row.id, c.row)
    const rows = [...all.values()].sort((a, b) => (Number(b.id === this.hub.current) - Number(a.id === this.hub.current)) || Number(!!this.hub.live.get(b.id)?.link.ready) - Number(!!this.hub.live.get(a.id)?.link.ready) || b.at - a.at)
    const signature = JSON.stringify([this.hub.loading, this.hub.saving, this.hub.current, this.hub.maxLive, rows.map((r) => [r.id, r.name, r.at, this.hub.live.get(r.id)?.link.status, this.hub.live.get(r.id)?.failure, this.hub.live.get(r.id)?.stats?.path, this.hub.live.get(r.id)?.stillConnecting])])
    if (signature === this.signature) return
    this.signature = signature
    const focus = document.activeElement as HTMLElement | null
    const focusRow = focus?.closest<HTMLElement>('.connection-row')?.dataset.connection
    const focusLabel = focus?.getAttribute('aria-label') ?? focus?.textContent
    const list = h('div', 'connection-list')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', 'Saved screens')
    list.setAttribute('aria-busy', String(this.hub.loading || this.hub.saving))
    for (const row of rows) list.append(this.entry(row))
    if (!rows.length) list.append(h('p', 'connection-empty', this.hub.loading ? 'Loading screens…' : 'Your screens will appear here.'))
    if (this.hub.saving) list.append(h('p', 'connection-saving', 'Saving…'))
    const tools = h('div', 'connection-actions')
    tools.append(button('Scan another code', () => this.scan(), 'btn primary'), button('Enter a code', () => this.code()))
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
    if (focus && !focus.isConnected) {
      const scope = [...list.children].find(el => (el as HTMLElement).dataset.connection === focusRow) ?? this.body
      const next = [...scope.querySelectorAll<HTMLElement>('button, select')].find(el => (el.getAttribute('aria-label') ?? el.textContent) === focusLabel)
      ;(next ?? this.dialog!.querySelector<HTMLElement>('[aria-label="Close connections"]'))?.focus()
    }
  }

  private entry(row: StoredConnection) {
    const c = this.hub.live.get(row.id)
    const active = row.id === this.hub.current
    const live = !!c?.welcome && !c.failure && c.link.ready
    const connecting = c && !live && !c.failure && pendingPhase(c.link.status)
    const needsCode = !live && !row.invite
    const el = h('div', 'connection-row')
    el.dataset.connection = row.id
    el.dataset.active = String(active)
    el.setAttribute('role', 'listitem')
    const use = button('', () => {
      if (needsCode) { this.hub.cancel(row.id); this.code(); return }
      if (connecting) { this.tell(c.stillConnecting ? STILL_CONNECTING : 'Connecting… You can cancel this attempt.'); return }
      tick()
      void this.hub.use(row.id).then(c => this.follow(c), (e: Error) => this.tell(e.message))
    }, 'connection-use')
    use.setAttribute('aria-label', `${live && active ? 'Active' : needsCode ? 'Pair again with' : connecting ? 'Connecting to' : 'Switch to'} ${row.name}`)
    const mark = h('span', 'connection-mark', active ? '●' : live ? 'Ⅱ' : '○')
    mark.setAttribute('aria-hidden', 'true')
    const label = h('span', 'connection-label')
    label.append(h('b', '', row.name), h('small', '', `${kinds[row.kind]} · ${active && live ? 'Connected' : live ? 'Available · paused' : connecting ? c.stillConnecting ? 'Still connecting' : 'Connecting…' : 'Offline'}`))
    if (needsCode) label.append(h('small', '', 'Enter current code'))
    const detail = h('span', 'connection-detail')
    const badge = h('small', 'connection-badge', 'Not connected')
    if (live) setMarkup(badge, html`${ICONS.lock}<span>${c?.stats?.path === 'relay' ? 'Relayed' : c?.stats?.path === 'direct' ? 'Direct' : 'Encrypted'}</span>`)
    detail.append(h('small', '', ago(row.at)), badge)
    use.append(mark, label, detail)
    const manage = h('div', 'connection-manage')
    const rename = button('Rename', () => this.rename(row), 'connection-option')
    rename.setAttribute('aria-label', `Rename ${row.name}`)
    const forget = button('Forget', () => {
      forget.disabled = true
      void this.hub.forget(row.id).then(() => { this.signature = ''; this.list(); this.tell('Forgotten. Scan again to reconnect.') })
    }, 'connection-option')
    forget.setAttribute('aria-label', `Forget ${row.name}`)
    manage.append(rename, forget)
    el.append(use)
    if (c && !live) {
      const recovery = h('div', 'connection-recovery')
      const progress = c.stillConnecting ? STILL_CONNECTING : 'Connecting… Keep the screen’s ob.Pal page open.'
      const state = h('p', 'connection-say', connecting ? c.link.status === 'unreachable' ? `ob.Pal is out of reach. ${progress}` : progress : this.refusal(c.failure ?? c.link.status))
      state.setAttribute('role', 'status')
      const actions = h('div', 'connection-actions')
      actions.append(button('Cancel attempt', () => {
        this.joining = null
        if (!this.hub.cancel(row.id)) return
        this.tell('Attempt cancelled. Your saved screens are kept.')
        this.dialog?.querySelector<HTMLElement>('[aria-label="Close connections"]')?.focus()
      }), button('Enter current code', () => { this.joining = null; this.hub.cancel(row.id); this.code() }))
      recovery.append(state, actions)
      el.append(recovery)
    }
    el.append(manage)
    return el
  }

  private refusal(status: Connection['link']['status']) {
    const text: Partial<Record<Connection['link']['status'], string>> = {
      'code-wrong': 'That code did not match. Enter the new one.', 'invite-used': 'That code was used. Enter the new one.',
      'host-mismatch': 'Could not verify this screen. Scan again.', full: 'This screen has no free place.',
      removed: 'This screen removed the phone.', 'taken-over': 'Another phone took over.',
      'lan-failed': 'Could not reach this screen over Wi-Fi.', 'lan-unsupported': 'Direct Wi-Fi is unavailable in this browser.',
    }
    return text[status] ?? 'Not connected. Enter the screen’s current code to pair again.'
  }

  private follow(c?: Connection) {
    if (!this.dialog || !c) return
    if (c.welcome && !c.failure && c.link.ready && this.hub.active === c) { this.close(); return }
    this.joining = c
    this.view = 'list'
    this.signature = ''
    this.tell('')
    this.list()
    this.dialog.querySelector<HTMLElement>('[aria-label="Close connections"]')?.focus()
  }

  private rename(row: StoredConnection) {
    if (!this.body) return
    this.view = 'rename'
    this.dialog!.querySelector('h2')!.textContent = 'Rename screen'
    this.tell('')
    const form = h('form', 'connection-rename')
    const input = h('input')
    input.value = row.name
    input.maxLength = 80
    input.setAttribute('aria-label', 'Screen name')
    const save = button('Save', () => {})
    save.type = 'submit'
    const back = () => { this.view = 'list'; this.signature = ''; this.list() }
    form.append(input, save, button('Cancel', back))
    form.onsubmit = (e) => {
      e.preventDefault()
      if (!input.value.trim() || save.disabled) return
      save.disabled = true
      form.setAttribute('aria-busy', 'true')
      this.tell('Saving…')
      void this.hub.rename(row.id, input.value).then(() => {
        if (!form.isConnected) return
        back()
        this.tell('Saved')
      })
    }
    this.body.replaceChildren(form)
    input.focus(); input.select()
  }

  private scan() {
    if (!this.body) return
    ++this.generation
    this.retireAttempt()
    this.stopCamera()
    this.view = 'scan'
    this.dialog!.querySelector('h2')!.textContent = 'Scan a code'
    this.signature = ''
    this.busy = false
    const camera = new CameraView({
      mode: 'scan', typed: () => this.code(),
      close: (reason) => {
        if (this.scanner !== camera) return
        this.scanner = null
        if (reason === 'close' && this.scanOnly) { this.close(); return }
        this.view = 'list'
        this.signature = ''
        this.tell('')
        this.list()
        if (reason === 'close') this.body?.querySelector<HTMLElement>('.connection-actions button')?.focus()
      },
      found: (text) => {
        const result = readScan(text, location.origin)
        if (!result) return
        tick()
        if (result.kind === 'short') { this.code(result.digits); void this.short(result.digits) }
        else void this.join(result.code)
      },
    })
    this.scanner = camera
    camera.open()
  }

  private code(digits = '') {
    if (!this.body) return
    ++this.generation
    this.retireAttempt()
    this.stopCamera()
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
    form.append(input, go, button('Scan instead', () => this.scan()), button('Back to connections', () => {
      ++this.generation
      this.busy = false
      this.view = 'list'
      this.signature = ''
      this.list()
      this.dialog?.querySelector<HTMLElement>('[aria-label="Close connections"]')?.focus()
    }))
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
    try { const c = await this.hub.connect(join); if (generation === this.generation) this.follow(c) }
    catch (e) { if (generation === this.generation) this.tell(e instanceof Error ? e.message : 'Could not connect. Try again.') }
  }

  private retireAttempt() {
    this.joining = null
    const pending = this.hub.attempt
    if (pending) this.hub.cancel(pending.row.id)
  }
}
