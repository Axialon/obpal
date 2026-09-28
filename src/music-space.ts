/** Playable surfaces in comfortable phone space, independent of camera framing. */
import { nearest, type ControlScope, type Reach } from './control-space'
import { DRUMS, scaleNote } from './music'

export const STATION_NAMES = ['Drum kit', 'Hand drums', 'Electronic pads', 'Warm synth', 'Piano', 'Marimba', 'Air', 'Percussion'] as const
export interface MusicTarget { seat: number; surface: number; n: number; melodic: boolean; x: number; y: number; label: string }
const kit: [number, number, number][] = [
  [0, 0, -0.72], [1, -0.42, -0.38], [2, -0.8, 0], [3, -0.8, -0.5],
  [4, 0.75, -0.22], [5, 0.32, 0.26], [6, -0.23, 0.3], [7, -0.62, 0.8], [8, 0.7, 0.74],
]
function makeTargets(seat: number): MusicTarget[] {
  const melodic = seat >= 3 && seat <= 6
  const points: [number, number, number][] = seat === 0 ? kit : seat === 1 || seat === 7
    ? [[9, -0.55, 0.42], [10, 0.4, 0.42], [11, -0.42, -0.42], [12, 0.55, -0.42]]
    : seat === 2 ? Array.from({ length: 9 }, (_, n) => [n, (n % 3 - 1) * 0.7, (1 - Math.floor(n / 3)) * 0.65])
    : seat === 6 ? [[0, 0, 0]] : Array.from({ length: 16 }, (_, n) => [n, -0.82 + n * 1.64 / 15, 0])
  return points.map(([surface, x, y]) => ({ seat, surface, x, y, melodic,
    n: melodic ? scaleNote(surface, 0, 3, 'pentatonic') : surface,
    label: melodic ? seat === 6 ? 'Air' : `${STATION_NAMES[seat]} ${surface + 1}` : DRUMS[surface],
  }))
}
const OBJECT_TARGETS = Array.from({ length: 8 }, (_, seat) => makeTargets(seat))
export const instrumentTargets = (seat: number): readonly MusicTarget[] => OBJECT_TARGETS[seat] ?? OBJECT_TARGETS[0]
/** Four station columns, two rows. Adjacent surfaces stay at least 4.2° apart. */
export const STUDIO_TARGETS: readonly MusicTarget[] = Array.from({ length: 8 }, (_, seat) => {
  const targets = instrumentTargets(seat), cx = -0.72 + (seat % 4) * 0.48, cy = seat < 4 ? 0.5 : -0.5
  if (seat === 0) return targets.map(t => ({ ...t, x: cx + t.x * 0.22, y: cy + (t.surface === 3 ? -0.72 : t.y) * 0.43 }))
  const cols = targets.length === 16 ? 4 : targets.length === 9 ? 3 : targets.length === 4 ? 2 : 1
  const rows = Math.ceil(targets.length / cols)
  return targets.map((t, j) => ({ ...t,
    x: cx + (cols === 1 ? 0 : -0.18 + (j % cols) * 0.36 / (cols - 1)),
    y: cy + (rows === 1 ? 0 : 0.35 - Math.floor(j / cols) * 0.7 / (rows - 1)),
  }))
}).flat()

export function musicTarget(aim: Reach, scope: ControlScope, seat: number): MusicTarget {
  return nearest(scope === 'scene' ? STUDIO_TARGETS : instrumentTargets(seat), aim)
}

/** A strike owns its aim. Changing the live cursor cannot move an event already in flight. */
export function resolveStrike(aim: Reach, eventScope: ControlScope, scope: ControlScope, seat: number, available: (seat: number) => boolean): MusicTarget | null {
  if (eventScope !== scope || !Number.isInteger(seat) || seat < 0 || seat >= STATION_NAMES.length) return null
  const target = musicTarget(aim, eventScope, seat)
  return available(target.seat) ? target : null
}
