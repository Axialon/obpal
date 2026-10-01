/** Fixed slots: priority first, then audibility, then oldest. Quiet movement yields to contact. */
export class VoiceBudget {
  readonly slots: { key: string; priority: number; level: number; age: number; active: boolean }[]
  private age = 0
  stolen = 0
  constructor(readonly limit = 32) {
    this.slots = Array.from({ length: limit }, () => ({ key: '', priority: 0, level: 0, age: 0, active: false }))
  }
  take(key: string, priority: number, level: number): number {
    let at = this.slots.findIndex(s => !s.active)
    if (at < 0) {
      at = this.slots.reduce((best, s, n, all) => s.priority < all[best].priority || s.priority === all[best].priority && (s.level < all[best].level || s.level === all[best].level && s.age < all[best].age) ? n : best, 0)
      if (this.slots[at].priority > priority || this.slots[at].priority === priority && this.slots[at].level > level) return -1
      this.stolen++
    }
    Object.assign(this.slots[at], { key, priority, level, age: ++this.age, active: true })
    return at
  }
  release(at: number) { this.slots[at].active = false }
  get active() { return this.slots.reduce((n, s) => n + Number(s.active), 0) }
}
