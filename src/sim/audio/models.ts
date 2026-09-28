import { unit, type Position, type SoundEvent } from './events'
import type { Tuning, Machine } from './tuning'

/** Load changes timbre independently of shaft speed; a stalled servo does not race. */
export function machineParameters(tuning: Tuning, event: SoundEvent) {
  const rpm = unit(event.rpm ?? event.strength), load = unit(event.load ?? rpm), bank = unit(event.bank ?? 0)
  const machine = event.kind === 'sustain'
    ? event.texture === 'water' ? 'water' : event.texture === 'scrape' ? 'scrape' : tuning.machine === 'engine' && event.texture === 'tracks' ? 'tracks' : 'roll'
    : tuning.machine
  const stall = machine === 'servo' ? unit((load - 0.55) / 0.45) * (1 - unit(rpm / 0.18)) : 0
  const rotor = machine === 'drone' || machine === 'helicopter' || machine === 'propeller'
  const rate = machine === 'vacuum' ? 0.88 + rpm * 0.2 : rotor ? 0.45 + rpm * 0.95 : 0.22 + rpm * 1.55
  const effort = unit(event.strength + stall * 0.45)
  return {
    machine: machine as Machine, rate, stall,
    gain: (machine === 'passive' ? 0 : (0.11 + 0.22 * Math.sqrt(effort)) * (0.8 + load * 0.5)) * tuning.level,
    body: unit(0.12 + load * 0.65 + bank * 0.23),
    // Rotor loading adds turbulence and slap, rather than making an unrelated bass tremolo.
    bodyRate: machine === 'servo' && stall > 0.1 ? 0.75 : rate * (1 + bank * 0.045),
    cutoff: machine === 'vacuum' ? 2600 + load * 1000 : machine === 'hydraulic' ? 1800 + load * 2400 : 2400 + rpm * 3300 + load * 700,
  }
}

export function airCutoff(distance: number, cutoff: number, underwater = false) {
  return Math.max(underwater ? 250 : 650, Math.min(cutoff, underwater ? 1800 : 19000) * Math.exp(-Math.max(0, distance) * (underwater ? 0.07 : 0.025)))
}

/** Relative radial velocity in m/s, positive when approaching. Teleports never make sonic booms. */
export function dopplerRate(source: Position, velocity: Position, listener: Position, listenerVelocity: Position, underwater = false) {
  const d = Math.hypot(source[0] - listener[0], source[1] - listener[1], source[2] - listener[2])
  if (d < 0.1) return 1
  let radial = 0
  for (let i = 0; i < 3; i++) radial += (velocity[i] - listenerVelocity[i]) * (listener[i] - source[i]) / d
  if (!Number.isFinite(radial)) return 1
  const c = underwater ? 1480 : 343
  return Math.max(0.85, Math.min(1.18, c / (c - Math.max(-55, Math.min(55, radial)))))
}
