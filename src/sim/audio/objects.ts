import { Vector3, Quaternion, type Object3D } from 'three'
import type { SimSound } from './engine'
import { unit, type SoundEvent } from './events'

/** Listen to measured object transforms; buffers and event envelopes are reused. */
export class ObjectSound {
  private objects = new Map<Object3D, { p: Vector3; q: Quaternion; at: [number, number, number]; event: SoundEvent; time: number }>()
  private p = new Vector3()
  private q = new Quaternion()
  constructor(private sound: SimSound) {}
  update(object: Object3D, source: string, who: string | undefined, now: number) {
    object.getWorldPosition(this.p); object.getWorldQuaternion(this.q)
    let state = this.objects.get(object)
    if (!state) {
      const at: [number, number, number] = [this.p.x, this.p.y, this.p.z]
      state = { p: this.p.clone(), q: this.q.clone(), at, event: { kind: 'motor', source, at, strength: 0, texture: 'servo' }, time: now }
      this.objects.set(object, state)
      return
    }
    if (now - state.time < 50) return
    const dt = Math.max(0.05, (now - state.time) / 1000)
    const movement = state.p.distanceTo(this.p) + state.q.angleTo(this.q) * 0.2
    state.at[0] = this.p.x; state.at[1] = this.p.y; state.at[2] = this.p.z
    state.event.strength = unit(movement / dt); state.event.rpm = state.event.strength; state.event.who = who
    state.event.load = unit(state.event.strength * 0.4)
    if (state.event.strength > 0.02 && now - state.time < 300) this.sound.bus.emit(state.event)
    state.p.copy(this.p); state.q.copy(this.q); state.time = now
  }
  prune(now: number) { for (const [object, state] of this.objects) if (now - state.time > 1000) this.objects.delete(object) }
}
