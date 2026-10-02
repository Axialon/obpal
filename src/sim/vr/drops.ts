import { distance, validVector, type Body, type V3 } from './world'

export interface DropObject { id: string; name: string; kind: Body['kind']; radius: number }
const block: DropObject = { id: 'block', name: 'Block', kind: 'block', radius: .16 }
const ball: DropObject = { id: 'ball', name: 'Ball', kind: 'ball', radius: .16 }
const cone: DropObject = { id: 'cone', name: 'Cone', kind: 'cone', radius: .18 }
/** Original procedural props, curated for the scene rather than fetched from a public asset service. */
export function dropCatalogue(sim: string): readonly DropObject[] {
  if (sim === 'marblerun') return [{ id: 'marble', name: 'Marble', kind: 'ball', radius: .055 }]
  if (sim === 'claw') return [{ ...ball, id: 'orb', name: 'Glass orb', radius: .08 }, { ...block, id: 'cube', name: 'Cube', radius: .07 }]
  if (['arm', 'humanoid', 'viewer', 'studio', 'ptz', 'gimbal', 'slider', 'jib', 'telescope', 'lamp', 'spotlights', 'smarthome', 'optics'].includes(sim)) return [block, ball]
  return [block, ball, cone]
}
export interface DropRequest { object: string; at: V3 | null; name?: string }
export interface DropCredit { who: string; color: string; name: string; until: number }
interface Pending { request: DropRequest; credit: DropCredit; object: DropObject; until: number }
export function validDrop(value: unknown): value is DropRequest {
  const d = value as DropRequest | null
  return !!d && typeof d.object === 'string' && d.object.length <= 32 && (d.at === null || validVector(d.at, 40)) && (d.name === undefined || typeof d.name === 'string' && d.name.length <= 24)
}
/** Only the host runs this queue. Safe placement is supplied by the sim and checked on its next physics tick. */
export class DropQueue {
  enabled: boolean
  private buckets = new Map<string, { tokens: number; at: number }>()
  private pending: Pending[] = []
  readonly live = new Map<string, DropCredit>()
  constructor(readonly catalogue: readonly DropObject[], readonly budget = 8, enabled = true) { this.enabled = enabled }
  get queued() { return this.pending.length }
  request(who: string, color: string, data: unknown, now: number, hardwareLive = false) {
    if (!this.enabled || hardwareLive || !validDrop(data)) return false
    const object = this.catalogue.find(o => o.id === data.object)
    if (!object || this.live.size + this.pending.length >= this.budget || this.pending.length >= 8) return false
    const bucket = this.buckets.get(who) ?? { tokens: 2, at: now }
    bucket.tokens = Math.min(2, bucket.tokens + Math.max(0, now - bucket.at) / 5000); bucket.at = now
    this.buckets.set(who, bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens--
    this.pending.push({ request: { ...data, at: data.at && [...data.at] }, object, credit: { who, color, name: data.name?.trim() ?? '', until: now + 15_000 }, until: now + 5000 })
    return true
  }
  tick(now: number, hardwareLive: boolean, place: (object: DropObject, at: V3 | null) => Body | null) {
    if (!this.enabled || hardwareLive) { this.pending = []; return }
    this.pending = this.pending.filter(p => {
      if (now >= p.until || this.live.size >= this.budget) return false
      const body = place(p.object, p.request.at)
      if (!body) return true
      this.live.set(body.id, { ...p.credit, until: now + 15_000 }); return false
    })
    for (const credit of this.live.values()) if (now >= credit.until) { credit.name = ''; credit.who = '' }
  }
  undo(remove: (id: string) => void) { const id = [...this.live.keys()].at(-1); if (id) { remove(id); this.live.delete(id) } }
  clear(remove: (id: string) => void) { this.pending = []; for (const id of this.live.keys()) remove(id); this.live.clear() }
  leave(who: string) { this.buckets.delete(who); this.pending = this.pending.filter(p => p.credit.who !== who) }
}
export function clearPlacement(p: V3, radius: number, occupied: readonly { p: V3; r: number }[]) {
  return validVector(p, 40) && p[1] >= radius && occupied.every(c => distance(p, c.p) > radius + c.r + .04)
}
/** Avatar hands can reach well beyond the head; neither may contain a new prop. */
export function playerDropBounds(people: Iterable<{ head: { p: V3 }; hands: readonly { p: V3 }[] }>) {
  return [...people].flatMap(person => [{ p: person.head.p, r: .4 }, ...person.hands.map(hand => ({ p: hand.p, r: .15 }))])
}
/** Near-player drops try a bounded ring so an existing prop cannot permanently block the entry point. */
export function nearDropPositions(near: V3, radius: number): V3[] {
  return Array.from({ length: 8 }, (_, n) => { const angle = n * Math.PI / 4; return [near[0] + Math.sin(angle) * 1.5, radius + .35, near[2] - Math.cos(angle) * 1.5] })
}
/** Cubes and cones extend beyond their physical radius at the corners. Admission covers the whole visible shape. */
export const dropClearance = (kind: Body['kind'], radius: number) => radius * (kind === 'block' || kind === 'pallet' ? 1.75 : kind === 'cone' ? 1.5 : 1)
