/** Per-participant music lifecycle: claims are external, voices never survive losing one. */
import type { MusicEvent } from '../../music'

export class StudioPlayers {
  private players = new Map<string, { seat: number; seen: number; seq: number; window: number; attacks: number }>()
  constructor(private stop: (seat: number) => void) {}
  accept(who: string, seat: number, e: MusicEvent, now: number): boolean {
    let p = this.players.get(who)
    if (p && p.seat !== seat) { this.stop(p.seat); this.players.delete(who); p = undefined }
    if (seat < 0 || seat >= 8) return false
    if (!p) { p = { seat, seen: now, seq: -1, window: now, attacks: 0 }; this.players.set(who, p) }
    if (e.seq <= p.seq) return false
    p.seq = e.seq; p.seen = now
    if (now - p.window >= 1000) { p.window = now; p.attacks = 0 }
    if (e.op === 'on' || e.op === 'hit') return ++p.attacks <= 80
    return true
  }
  drop(who: string) { const p = this.players.get(who); if (p) this.stop(p.seat); this.players.delete(who) }
  check(now: number, seatOf: (who: string) => number) {
    for (const [who, p] of this.players) if (now - p.seen > 1000 || p.seat !== seatOf(who)) this.drop(who)
  }
  silence() { for (const who of this.players.keys()) this.drop(who) }
}
