import type { DeviceEvent, DeviceLogic } from '../devices/types'
import { deviceEvent, unit, type Position, type SoundEvent } from './events'
import type { SimSound } from './engine'

/** Reused unit motion samples and event envelopes, with optional per-body profile voices. */
export class DeviceSound {
  private states: { data: Float64Array; prev: Float64Array; at: [number, number, number]; velocity: [number, number, number]; event: SoundEvent; ready: boolean }[]
  private last = -Infinity
  constructor(private logic: DeviceLogic, private sound: SimSound, private owner: (n: number) => string | undefined) {
    this.states = Array.from({ length: logic.spec.units }, (_, n) => {
      const at: [number, number, number] = [0, 0, 0]
      const velocity: [number, number, number] = [0, 0, 0]
      return { data: new Float64Array(11), prev: new Float64Array(11), at, velocity, event: { kind: 'motor', source: `${logic.spec.id}${n}`, spatialGroup: `${logic.spec.id}${n}`, at, velocity, strength: 0 }, ready: false }
    })
  }
  update(now: number, events: readonly DeviceEvent[]) {
    const read = this.sound.profile.read
    if (!read) { this.sound.tick(now); return }
    const sample = now - this.last >= 50
    const dt = Math.min(0.2, Math.max(0.001, (now - this.last) / 1000))
    if (sample || events.length) this.states.forEach((s, n) => {
      read(this.logic, n, s.data)
      for (let i = 0; i < 3; i++) s.at[i] = s.data[i]
      if (!sample) return
      this.sound.profile.motion?.(this.logic, n, event => this.sound.bus.emit({ ...event, who: this.owner(n) }))
      let motion = 0
      if (s.ready) for (let i = 7; i < 11; i++) motion += Math.abs(s.data[i] - s.prev[i]) / dt
      for (let i = 0; i < 3; i++) s.velocity[i] = s.ready ? (s.data[i] - s.prev[i]) / dt : 0
      const flight = ['drone', 'helicopter', 'plane'].includes(this.logic.spec.id)
      // Flight's extra channels carry pitch and bank; they must not masquerade as shaft RPM.
      const jointMotion = flight ? 0 : motion
      const acceleration = s.ready ? Math.abs(s.data[3] - s.prev[3]) / dt : 0
      const e = s.event
      e.who = this.owner(n); e.kind = 'motor'; e.texture = this.sound.profile.texture
      e.bank = flight ? unit(motion * 0.35 + Math.abs(s.data[8]) * 0.6) : 0
      e.rpm = unit(s.data[3] + jointMotion * 0.4); e.load = unit(s.data[4] + jointMotion * 0.2 + acceleration * 0.12); e.strength = e.rpm
      if (e.strength > 0.02) this.sound.bus.emit(e)
      if (s.data[5] > 0.02) {
        e.kind = 'sustain'; e.strength = unit(s.data[5]); e.rpm = e.strength
        e.texture = this.sound.profile.id === 'tank' ? 'tracks' : this.sound.profile.id === 'kart' ? 'scrape' : this.sound.profile.space === 'underwater' || this.sound.profile.id === 'boat' ? 'water' : 'roll'
        this.sound.bus.emit(e)
      }
      if (this.logic.spec.id === 'dog' && s.ready && s.data[3] > 0.03 && Math.floor(s.data[6] / Math.PI) !== Math.floor(s.prev[6] / Math.PI)) {
        e.kind = 'footstep'; e.strength = unit(0.25 + s.data[3]); e.load = unit(0.45 + s.data[3] * 0.4); this.sound.bus.emit(e)
      }
      s.prev.set(s.data); s.ready = true
    })
    for (const e of events) {
      const s = this.states[e.unit]
      if (s) this.sound.bus.emit(deviceEvent(e, `${this.logic.spec.id}${e.unit}`, e.audio?.at ?? s.at as Position, this.owner(e.unit)))
    }
    if (sample) this.last = now
    this.sound.tick(now)
  }
}
