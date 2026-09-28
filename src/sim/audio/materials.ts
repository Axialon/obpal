import { unit, type Material } from './events'

/** Resonant frequency, decay and noisy fraction of each original material voice. */
export const MATERIALS: Record<Material, { hz: number; decay: number; noise: number }> = {
  metal: { hz: 620, decay: 0.65, noise: 0.12 }, rubber: { hz: 85, decay: 0.09, noise: 0.18 },
  tile: { hz: 960, decay: 0.18, noise: 0.3 }, wood: { hz: 240, decay: 0.16, noise: 0.25 },
  plastic: { hz: 360, decay: 0.12, noise: 0.4 }, glass: { hz: 1800, decay: 0.85, noise: 0.06 },
  water: { hz: 130, decay: 0.4, noise: 0.9 },
}

export function impactGain(speed: number, impulse = speed) {
  if (!Number.isFinite(speed) || !Number.isFinite(impulse) || speed <= 0 || impulse <= 0) return 0
  return unit(Math.sqrt(speed * Math.min(impulse, 8)) / 5)
}

export function materialPair(a: Material, b: Material) {
  const x = MATERIALS[a], y = MATERIALS[b]
  return { hz: Math.sqrt(x.hz * y.hz), decay: Math.sqrt(x.decay * y.decay), noise: (x.noise + y.noise) / 2 }
}
