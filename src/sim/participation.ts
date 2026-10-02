export type Role = 'play' | 'watch'
export interface PresencePerson { id: string; name: string; color: string; role: Role; seat?: string; lead?: boolean }
export interface Vote { id: string; x: number; y: number; accepted: boolean }
export interface AudienceState { mode: 'off' | 'queue' | 'crowd'; unit: string; turn: string | null; next: string[]; remaining: number; seconds: number; direction: [number, number]; votes: Vote[] }
export interface RoomState { people: PresencePerson[]; requests: string[]; audience: AudienceState; units: { id: string; name: string; busy?: boolean }[]; you: string }

/** Players remain visible; a long audience collapses to one live count. */
export function presenceStrip(people: PresencePerson[], limit = 8) {
  const players = people.filter(p => p.role === 'play'), watchers = people.filter(p => p.role === 'watch')
  return { players, watchers: watchers.slice(0, limit), watcherCount: watchers.length, collapsed: Math.max(0, watchers.length - limit) }
}

/** Requests and grants stay bound to connected identities and one seat. No key is issued. */
export class Handover {
  readonly requests = new Set<string>()
  readonly grants = new Map<string, string>()
  ask(id: string, watchers: ReadonlySet<string>) { if (!watchers.has(id) || this.requests.size >= 24) return false; this.requests.add(id); return true }
  decline(id: string) { this.requests.delete(id) }
  accept(id: string, seat: string | undefined, watchers: ReadonlySet<string>, occupied: ReadonlySet<string>) {
    if (!watchers.has(id) || !seat || occupied.has(seat) || this.grants.size >= 8) return false
    this.requests.delete(id); this.grants.set(id, seat); return true
  }
  give(from: string, to: string, seat: string | undefined, watchers: ReadonlySet<string>) {
    if (from === to || !seat || !watchers.has(to)) return false
    this.grants.delete(from); this.grants.set(to, seat); this.requests.delete(to); return true
  }
  leave(id: string) { this.requests.delete(id); this.grants.delete(id) }
}

/** One current vote per watcher, at 20 Hz, expiring in 250 ms. Median distance rejects isolated directions. */
export function aggregateVotes(votes: { id: string; x: number; y: number }[]): { direction: [number, number]; votes: Vote[] } {
  const sorted = votes.slice(0, 24).filter(v => Number.isFinite(v.x) && Number.isFinite(v.y) && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const median = (values: number[]) => { const s = values.sort((a, b) => a - b), mid = Math.floor(s.length / 2); return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2 }
  if (!sorted.length) return { direction: [0, 0], votes: [] }
  const mx = median(sorted.map(v => v.x)), my = median(sorted.map(v => v.y))
  const marked = sorted.map(v => ({ ...v, accepted: sorted.length < 3 || Math.hypot(v.x - mx, v.y - my) <= .8 }))
  const accepted = marked.filter(v => v.accepted), n = accepted.length || 1
  const x = accepted.reduce((sum, v) => sum + v.x, 0) / n, y = accepted.reduce((sum, v) => sum + v.y, 0) / n, scale = Math.max(1, Math.hypot(x, y))
  return { direction: [x / scale, y / scale], votes: marked }
}

/** The host's monotonic clock owns turn boundaries. Changing modes clears input and queued turns. */
export class Audience {
  mode: AudienceState['mode'] = 'off'
  unit = ''
  seconds = 60
  private queue: string[] = []
  private turn: string | null = null
  private until = 0
  private votes = new Map<string, { x: number; y: number; at: number; seq: number }>()
  private sequence = new Map<string, number>()
  private commands = new Map<string, { seq: number; at: number }>()
  configure(mode: AudienceState['mode'], unit: string, seconds = 60) {
    this.mode = mode; this.unit = unit; this.seconds = Math.max(1, Math.min(300, Number.isFinite(seconds) ? Math.round(seconds) : 60))
    this.queue = []; this.turn = null; this.until = 0; this.votes.clear()
  }
  command(id: string, seq: number, op: 'join' | 'leave', now: number, watchers: ReadonlySet<string>) {
    const last = this.commands.get(id)
    if (!watchers.has(id) || last && (seq <= last.seq || now - last.at < 100)) return false
    this.commands.set(id, { seq, at: now })
    if (op === 'join') return this.join(id, watchers, now)
    this.leave(id); this.commands.set(id, { seq, at: now }); return true
  }
  join(id: string, watchers: ReadonlySet<string>, now: number) {
    if (this.mode !== 'queue' || !watchers.has(id) || id === this.turn || this.queue.includes(id) || this.queue.length + (this.turn ? 1 : 0) >= 24) return false
    this.queue.push(id); this.tick(now, watchers); return true
  }
  leave(id: string) { this.queue = this.queue.filter(w => w !== id); this.votes.delete(id); if (this.turn === id) { this.turn = null; this.until = 0 } }
  disconnect(id: string) { this.leave(id); this.sequence.delete(id); this.commands.delete(id) }
  input(id: string, seq: number, x: number, y: number, now: number, watchers: ReadonlySet<string>) {
    this.tick(now, watchers)
    if (!watchers.has(id) || this.mode === 'off' || this.mode === 'queue' && this.turn !== id || !Number.isSafeInteger(seq) || seq <= (this.sequence.get(id) ?? -1) || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1 || Math.abs(y) > 1) return false
    const previous = this.votes.get(id)
    if (!previous && this.votes.size >= 24) return false
    // Neutral releases always pass the rate gate.
    if (previous && now - previous.at < 50 && (x !== 0 || y !== 0)) return false
    const scale = Math.max(1, Math.hypot(x, y))
    this.votes.set(id, { x: x / scale, y: y / scale, at: now, seq }); this.sequence.set(id, seq); return true
  }
  tick(now: number, watchers: ReadonlySet<string>) {
    this.queue = this.queue.filter(id => watchers.has(id))
    for (const [id, vote] of this.votes) if (!watchers.has(id) || now - vote.at >= 250) this.votes.delete(id)
    if (this.turn && (!watchers.has(this.turn) || now >= this.until)) { this.votes.delete(this.turn); this.turn = null }
    if (this.mode === 'queue' && !this.turn && this.queue.length) { this.turn = this.queue.shift()!; this.until = now + this.seconds * 1000; this.votes.clear() }
  }
  snapshot(now: number, watchers: ReadonlySet<string>): AudienceState {
    this.tick(now, watchers)
    const votes = [...this.votes].filter(([, v]) => now - v.at < 250).map(([id, v]) => ({ id, x: v.x, y: v.y }))
    const aggregate = aggregateVotes(votes)
    return { mode: this.mode, unit: this.unit, turn: this.turn, next: [...this.queue], remaining: this.turn ? Math.max(0, Math.ceil((this.until - now) / 1000)) : 0, seconds: this.seconds, ...aggregate }
  }
}
