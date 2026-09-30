/** Live links belong here; the controller surface only ever sends through the active one. */
import {
  b64url, DeviceLink, encodeLanPairing, encodePairing, forgetConnection, getPair, listConnections, parsePairingCode, putConnection, removeConnection, roomIdFor, saveInvite,
  type Caps, type DeviceMsg, type HostMsg, type LinkStats, type LinkStatus, type ConnectionSeal, type PairingCode, type StoredConnection,
} from '@obpal/core'

export type Join = PairingCode | { v: 'code'; code: { handle: string; secret: string; room: string; ticket: string } }
  | { v: 'saved'; row: StoredConnection }
type Welcome = Extract<HostMsg, { t: 'welcome' }>
export interface Connection {
  row: StoredConnection
  link: DeviceLink
  welcome?: Welcome
  values: Record<string, number | boolean | string>
  scene?: Extract<HostMsg, { t: 'scene' }>
  stats?: LinkStats
}

export interface ConnectionDeps {
  service: string
  cert: Promise<RTCCertificate | null>
  name: Promise<string>
  caps(): Caps
  beforeSwitch(): void
  switched(connection: Connection | null): void
  status(status: LinkStatus): void
  message(message: HostMsg): void
  stats(stats: LinkStats): void
  seal?(s: { seal: ConnectionSeal; delayMs: number; source?: string }): void
  notice?(text: string): void
  create?: (options: ConstructorParameters<typeof DeviceLink>[0]) => DeviceLink
}

export class Connections {
  readonly rows = new Map<string, StoredConnection>()
  readonly live = new Map<string, Connection>()
  active: Connection | null = null
  changed = () => {}
  private suspended = false
  private wanted = ''
  private generation = 0
  private forgetting = new Set<string>()
  private limit = 3
  private loaded: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  private pending = 0
  loading = true

  constructor(private deps: ConnectionDeps) {
    this.loaded = listConnections().then((rows) => { for (const r of rows) this.rows.set(r.id, r); this.loading = false; this.changed() })
  }

  get ready() { return !this.suspended && !!this.active?.welcome && this.active.link.ready }
  get status(): LinkStatus { return this.active?.link.status ?? 'closed' }
  get maxLive() { return this.limit }
  get current() { return this.active?.row.id ?? '' }
  get saving() { return this.pending > 0 }
  async settled() {
    await this.loaded
    // Imports and the transactions they produce belong to the same queue. Include writes added while waiting.
    let last: Promise<void>
    do { last = this.writes; await last } while (last !== this.writes)
  }

  setLimit(n: number) {
    this.limit = Number.isInteger(n) ? Math.max(1, Math.min(4, n)) : 3
    this.trim()
    this.changed()
  }

  /** The UI's only outbound route. Housekeeping remains inside each DeviceLink. */
  sendCtl(m: DeviceMsg) { if (this.ready) this.active!.link.sendCtl(m) }
  sendState(b: ArrayBuffer) { return this.ready ? this.active!.link.sendState(b) : false }

  /** Opening a scanner or switching screens releases the current controls before their route changes. */
  suspend(on: boolean) {
    if (on === this.suspended) return
    if (on) this.deps.beforeSwitch()
    this.suspended = on
    if (this.active?.link.ready) this.active.link.sendCtl({ t: 'attention', active: !on })
    if (!on && this.active?.welcome) {
      this.deps.message(this.active.welcome)
      this.deps.message({ t: 'state', values: this.active.values })
      if (this.active.scene) this.deps.message(this.active.scene)
    }
  }

  async connect(join: Join) {
    const generation = ++this.generation
    await this.loaded
    const common = { service: this.deps.service, cert: this.deps.cert, caps: this.deps.caps, name: this.deps.name, remember: true }
    const pair = join.v === 2 ? await getPair(b64url(join.lan.id)) : null
    if (join.v === 2 && !pair) throw new Error('Pair online once first. Scan the regular code on this screen.')
    if (join.v === 'saved' && !join.row.invite) throw new Error('Scan this screen’s current code to reconnect.')
    const id = join.v === 'saved' ? join.row.id : join.v === 2 ? [...this.rows.values()].find((r) => r.pairId === pair!.id)?.id ?? `pair:${pair!.id}`
      : `room:${join.v === 'code' ? join.code.room : await roomIdFor(join.pairing.secret)}`
    if (generation !== this.generation) return
    if (this.forgetting.has(id)) throw new Error('This screen is being forgotten. Try again in a moment.')
    const existing = this.live.get(id)
    if (existing?.link.ready) { this.activate(id); return }
    if (existing) this.drop(id)
    const options = join.v === 'saved' ? { ...common, saved: join.row.invite! }
      : join.v === 2 ? { ...common, lan: join.lan, pair: pair! }
        : join.v === 'code' ? { ...common, code: join.code } : { ...common, pairing: join.pairing }
    const link = (this.deps.create ?? ((o) => new DeviceLink(o)))(options)
    const row = this.rows.get(id) ?? { id, name: pair?.peerName ?? 'New screen', kind: pair ? 'pc' : 'site', at: Date.now(), ...(pair ? { pairId: pair.id } : {}) }
    const c: Connection = { row, link, values: {} }
    // Only the finite QR-to-seal effect needs the original modules. Do not put invite bytes in a UI snapshot.
    let sealSource = join.v === 1 ? encodePairing(join.pairing) : join.v === 2 ? encodeLanPairing(join.lan) : undefined
    this.live.set(id, c)
    this.wanted = id
    // A pending join takes a slot too. Keep the active screen until the new one has proved itself.
    this.trim(id)
    link.on('status', (s) => {
      if (this.live.get(id) !== c) return
      if (s !== 'connected') { c.stats = undefined; c.values = {}; c.scene = undefined }
      if (this.active === c || (!this.active && this.wanted === id)) this.deps.status(s)
      const refusal: Partial<Record<LinkStatus, string>> = { 'code-wrong': 'That code did not match. Enter the new one.', 'invite-used': 'That code was used. Scan the new one.', 'host-mismatch': 'Could not verify this screen. Scan again.', removed: 'This screen removed the phone.', full: 'This screen has no free place.', 'lan-failed': 'Could not reach this screen over Wi-Fi.', 'lan-unsupported': 'Direct Wi-Fi is unavailable in this browser.' }
      if (refusal[s] && this.wanted === id) this.deps.notice?.(refusal[s]!)
      if (['removed', 'invite-used', 'host-mismatch'].includes(s) && this.rows.has(id)) {
        const { invite: _invite, ...metadata } = c.row
        c.row = metadata
        this.save(c.row)
      }
      this.changed()
    })
    link.on('message', (m) => {
      if (this.live.get(id) !== c) return
      if (m.t === 'welcome') {
        // Cache no grants or invite bytes in a renderable snapshot.
        c.welcome = { t: 'welcome', proto: m.proto, name: String(m.name).slice(0, 80), layout: m.layout, attention: m.attention, kind: m.kind }
        c.row = { ...c.row, name: c.row.renamed ? c.row.name : c.welcome.name, kind: m.kind && ['pc', 'sim', 'viewer', 'site'].includes(m.kind) ? m.kind : c.row.kind,
          ...(m.pair && /^[A-Za-z0-9_-]{22}$/.test(m.pair.id) ? { pairId: m.pair.id } : {}) }
        if (join.v === 1) this.rememberInvite(c, join.pairing)
        this.save(c.row)
        if (this.wanted === id || this.active === c) { this.activate(id, true); return }
        link.sendCtl({ t: 'attention', active: false })
      } else if (m.t === 'layout' && c.welcome) c.welcome = { ...c.welcome, layout: m.layout }
      else if (m.t === 'state') Object.assign(c.values, m.values)
      else if (m.t === 'scene') c.scene = { ...m, nodes: m.nodes ?? c.scene?.nodes }
      if (this.active === c && !this.suspended) this.deps.message(m)
      this.changed()
    })
    link.on('invite', (fragment) => {
      sealSource = fragment
      const parsed = parsePairingCode(fragment)
      if (parsed?.v !== 1) return
      this.rememberInvite(c, parsed.pairing)
    })
    link.on('pair', (p) => {
      if (this.live.get(id) !== c) return
      // Merge the old PC entry (including a local rename) when the authenticated grant identifies it.
      for (const old of this.rows.values()) if (old.id !== id && old.pairId === p.id) {
        if (old.renamed) c.row = { ...c.row, name: old.name, renamed: true }
        this.rows.delete(old.id)
        this.drop(old.id)
        this.write(() => removeConnection(old.id))
      }
      c.row = { ...c.row, pairId: p.id }
      this.save(c.row)
    })
    link.on('seal', (s) => {
      if (this.active === c) this.deps.seal?.({ ...s, ...(sealSource ? { source: `${this.deps.service}/p/#${sealSource}` } : {}) })
      sealSource = undefined
    })
    link.on('stats', (s) => {
      if (this.live.get(id) !== c) return
      c.stats = s
      if (this.active === c) this.deps.stats(s)
      this.changed()
    })
    if (!this.active) this.deps.status('connecting')
    else this.deps.notice?.('Connecting to another screen…')
    this.changed()
    void link.start().catch(() => { if (this.live.get(id) === c) { this.drop(id); this.changed() } })
  }

  activate(id: string, refresh = false) {
    const next = this.live.get(id)
    if (!next?.welcome || !next.link.ready) return
    // Reconnecting the old active screen must not override a newer choice still pairing.
    if (!refresh) this.wanted = id
    if (next === this.active && !refresh) return
    this.deps.beforeSwitch()
    this.active?.link.sendCtl({ t: 'attention', active: false })
    this.active = next
    next.row = { ...next.row, at: Date.now() }
    this.save(next.row)
    next.link.sendCtl({ t: 'attention', active: !this.suspended })
    // The old sessionStorage invite must never reconnect a forgotten or different screen on reload.
    try { sessionStorage.removeItem('obpal.pair'); sessionStorage.setItem('obpal.active', id) } catch { /* session only */ }
    this.deps.switched(next)
    if (next.stats) this.deps.stats(next.stats)
    this.trim()
    this.changed()
  }

  async use(id: string) {
    const row = this.rows.get(id)
    if (this.live.get(id)?.link.ready) this.activate(id)
    else if (row) await this.connect({ v: 'saved', row })
  }

  async rename(id: string, name: string) {
    const row = this.rows.get(id)
    const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 80)
    if (!row || !clean || this.forgetting.has(id)) return
    const next = { ...row, name: clean, renamed: true }
    const c = this.live.get(id)
    if (c) c.row = next
    this.save(next)
    await this.settled()
  }

  async forget(id: string) {
    if (this.forgetting.has(id)) { await this.writes; return }
    this.forgetting.add(id)
    ++this.generation
    const row = this.rows.get(id)
    this.drop(id)
    if (row) this.write(() => forgetConnection(row))
    try { if (sessionStorage.getItem('obpal.active') === id) sessionStorage.removeItem('obpal.active'); sessionStorage.removeItem('obpal.pair') } catch { /* private mode */ }
    await this.writes
    this.rows.delete(id)
    this.forgetting.delete(id)
    this.changed()
  }

  close() { if (this.active) this.drop(this.active.row.id); this.changed() }
  destroy() { ++this.generation; for (const id of [...this.live.keys()]) this.drop(id) }

  private drop(id: string) {
    const c = this.live.get(id)
    if (!c) return
    if (this.active === c) { this.deps.beforeSwitch(); this.active = null; this.deps.switched(null) }
    this.live.delete(id)
    c.link.close()
  }

  private trim(pending = '') {
    const idle = [...this.live.values()].filter((c) => c !== this.active && c.row.id !== pending).sort((a, b) => a.row.at - b.row.at)
    while (this.live.size > Math.max(this.limit, pending && this.active ? 2 : 1) && idle.length) this.drop(idle.shift()!.row.id)
  }
  private rememberInvite(c: Connection, pairing: Parameters<typeof saveInvite>[0]) {
    this.write(async () => {
      const invite = await saveInvite(pairing)
      const id = c.row.id
      if (this.live.get(id) !== c || this.forgetting.has(id)) return
      c.row = { ...c.row, invite }
      this.rows.set(id, c.row)
      await putConnection(c.row)
    })
  }

  private write(fn: () => Promise<void>) {
    ++this.pending
    this.writes = this.writes.then(fn).catch(() => { /* memory remains usable */ }).finally(() => {
      --this.pending
      this.changed()
    })
    this.changed()
  }
  private save(row: StoredConnection) {
    this.rows.set(row.id, row)
    // An invite import or a rename can finish before this job starts; never overwrite it with an older snapshot.
    this.write(async () => { const current = this.rows.get(row.id); if (current) await putConnection(current) })
  }
}
