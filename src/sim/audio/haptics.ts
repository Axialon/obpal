import { impactGain } from './materials'
import { unit, type SoundEvent } from './events'

export function hapticOf(e: SoundEvent) {
  const s = e.speed === undefined ? unit(e.strength) : impactGain(e.speed, e.impulse)
  if (s < 0.035) return null
  if (e.kind === 'contact') return { strong: s * 0.85, weak: s * 0.4, ms: Math.round(20 + s * 100) }
  if (e.kind === 'motor' && e.texture === 'servo') return { strong: 0, weak: s * 0.3, ms: 12 }
  if (e.kind === 'motor' || e.kind === 'sustain') return { strong: s * 0.08, weak: s * 0.2, ms: 35 }
  return { strong: 0, weak: s * 0.6, ms: e.kind === 'footstep' ? 18 : 12 }
}

/** One shared limiter per participant, across every source they own. */
export class HapticGate {
  private sent = new Map<string, { last: number; continuous: number }>()
  accept(who: string, e: SoundEvent, now: number) {
    const continuous = e.kind === 'motor' || e.kind === 'sustain'
    const was = this.sent.get(who)
    if (was && (now - was.last < 100 || continuous && now - was.continuous < 400)) return false
    this.sent.set(who, { last: now, continuous: continuous ? now : was?.continuous ?? -Infinity })
    return true
  }
  drop(who: string) { this.sent.delete(who) }
  clear() { this.sent.clear() }
}
