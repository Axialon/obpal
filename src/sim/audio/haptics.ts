import { impactGain } from './materials'
import { unit, type SoundEvent } from './events'

export function hapticOf(e: SoundEvent) {
  if (e.glass === 'roll' || e.glass === 'drag') return null
  const s = e.speed === undefined ? unit(e.strength) : impactGain(e.speed, e.impulse)
  if (s < 0.035) return null
  if (e.glass === 'clack') return { strong: s * 0.7, weak: s * 0.25, ms: Math.round(18 + s * 25) }
  if (e.kind === 'contact') return { strong: s * 0.85, weak: s * 0.4, ms: Math.round(20 + s * 100) }
  if (e.kind === 'footstep') return { strong: s * 0.34, weak: s * 0.13, ms: 22 }
  if (e.kind === 'motor' && e.texture === 'servo') {
    const stall = unit(((e.load ?? 0) - 0.6) / 0.4) * (1 - unit((e.rpm ?? s) / 0.2))
    return stall > 0.2 ? { strong: stall * 0.38, weak: stall * 0.16, ms: 65 } : { strong: 0, weak: s * 0.22, ms: 12 }
  }
  if (e.kind === 'motor' && e.texture === 'rotor') {
    const bank = unit(e.bank ?? 0)
    return bank > 0.3 ? { strong: bank * 0.22, weak: bank * 0.42, ms: 45 } : null
  }
  if (e.kind === 'motor' || e.kind === 'sustain') return { strong: s * 0.08, weak: s * 0.2, ms: 35 }
  return { strong: 0, weak: s * 0.6, ms: 12 }
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
