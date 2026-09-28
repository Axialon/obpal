/** Small authoritative props. Existing engines can supply a binding instead of a second simulation. */
export type V3 = [number, number, number]
export interface Body { id: string; kind: 'cone' | 'ball' | 'block' | 'pallet'; p: V3; v: V3; r: number; owner: string | null; bound?: boolean }
export interface Collider { p: V3; r: number; move?(x: number, z: number): void }
export interface Binding { read(): V3; write(p: V3, v: V3): void; busy?(): boolean }
export const distance = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
export const validVector = (p: unknown, bound = 100) => Array.isArray(p) && p.length === 3 && p.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= bound)

export class PropWorld {
  readonly bodies: Body[] = []
  private bindings = new Map<string, Binding>()
  private hands = new Map<string, { p: V3; at: number; velocity: V3 }>()
  private thrown = new Set<string>()
  add(kind: Body['kind'], p: V3, r: number, binding?: Binding) {
    const b: Body = { id: `prop${this.bodies.length + 1}`, kind, p: [...p], v: [0, 0, 0], r, owner: null }
    this.bodies.push(b)
    if (binding) { this.bindings.set(b.id, binding); b.bound = true }
    return b
  }
  grab(who: string, id: string, hand: V3, now: number) {
    const b = this.bodies.find(x => x.id === id)
    if (!b || b.owner || this.bodies.some(x => x.owner === who) || !validVector(hand) || distance(b.p, hand) > 1.5 || this.bindings.get(id)?.busy?.()) return false
    b.owner = who
    this.thrown.delete(b.id)
    b.v = [0, 0, 0]
    this.hands.set(who, { p: [...hand], at: now, velocity: [0, 0, 0] })
    return true
  }
  move(who: string, p: V3, now: number) {
    const h = this.hands.get(who), b = this.bodies.find(x => x.owner === who)
    if (!h || !b || !validVector(p)) return false
    const dt = Math.max(0.01, Math.min(0.2, (now - h.at) / 1000))
    if (distance(p, h.p) > 12 * dt + 0.15) return false
    h.velocity = p.map((v, i) => Math.max(-6, Math.min(6, (v - h.p[i]) / dt))) as V3
    h.p = [...p]; h.at = now
    b.p = [...p]; b.p[1] = Math.max(b.r, b.p[1])
    this.bindings.get(b.id)?.write(b.p, [0, 0, 0])
    return true
  }
  release(who: string, toss = true) {
    const h = this.hands.get(who)
    for (const b of this.bodies) if (b.owner === who) {
      b.owner = null; b.v = toss && h ? [...h.velocity] : [0, 0, 0]
      if (toss && h) this.thrown.add(b.id)
      this.bindings.get(b.id)?.write(b.p, b.v)
    }
    this.hands.delete(who)
  }
  step(dt: number, now: number, colliders: Collider[] = []) {
    dt = Math.min(0.05, Math.max(0, dt))
    for (const [who, h] of this.hands) if (now - h.at > 500) this.release(who, false)
    for (const b of this.bodies) {
      const binding = this.bindings.get(b.id)
      if (b.owner) { binding?.write(b.p, [0, 0, 0]); continue }
      if (binding && !this.thrown.has(b.id)) { b.p = binding.read(); continue }
      b.v[1] -= 9.81 * dt
      for (let i = 0; i < 3; i++) b.p[i] += b.v[i] * dt
      if (b.p[1] < b.r) { b.p[1] = b.r; b.v[1] = Math.abs(b.v[1]) > 0.5 ? -b.v[1] * 0.3 : 0; b.v[0] *= Math.exp(-3 * dt); b.v[2] *= Math.exp(-3 * dt) }
      for (const c of colliders) {
        const d = distance(b.p, c.p), reach = b.r + c.r
        if (d >= reach) continue
        const n = b.p.map((v, i) => d > 1e-5 ? (v - c.p[i]) / d : i === 0 ? 1 : 0) as V3
        for (let i = 0; i < 3; i++) { b.p[i] += n[i] * (reach - d); b.v[i] = Math.max(-6, Math.min(6, b.v[i] + n[i] * 1.8)) }
        c.move?.(-n[0] * (reach - d) * 0.1, -n[2] * (reach - d) * 0.1)
      }
      if (Math.hypot(...b.p) > 80) { b.p = [0, b.r, 0]; b.v = [0, 0, 0] }
      binding?.write(b.p, b.v)
      if (Math.hypot(...b.v) < 0.04 && b.p[1] <= b.r + 0.001) this.thrown.delete(b.id)
    }
    for (let i = 0; i < this.bodies.length; i++) for (let j = i + 1; j < this.bodies.length; j++) {
      const a = this.bodies[i], b = this.bodies[j]
      if (a.owner || b.owner || this.bindings.has(a.id) || this.bindings.has(b.id)) continue
      const d = distance(a.p, b.p), reach = a.r + b.r
      if (d >= reach) continue
      for (let k = 0; k < 3; k++) {
        const n = d > 1e-5 ? (b.p[k] - a.p[k]) / d : k === 0 ? 1 : 0
        const push = n * (reach - d) * 0.5
        a.p[k] -= push; b.p[k] += push
        const impulse = (a.v[k] - b.v[k]) * n
        if (impulse > 0) { a.v[k] -= impulse * n * 0.7; b.v[k] += impulse * n * 0.7 }
      }
    }
  }
}
