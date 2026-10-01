/** Acoustic identities, deliberately separate from controller and device logic. */
export type Machine = 'servo' | 'drive' | 'drone' | 'helicopter' | 'propeller' | 'vacuum' | 'hydraulic' | 'engine' | 'tracks' | 'roll' | 'scrape' | 'water' | 'air' | 'fan' | 'passive'
export type Category = 'mechanism' | 'vehicle' | 'flight' | 'household' | 'table' | 'water' | 'passive'
export type SampleSet = 'mechanical' | 'feet' | 'vacuum' | 'wood' | 'none'
export interface Tuning {
  machine: Machine
  category: Category
  /** Shaft or blade-pass frequency at the buffer's reference speed, in Hz. */
  hz: number
  mesh: number
  level: number
  samples: SampleSet
}

const tune = (machine: Machine, category: Category, hz: number, mesh: number, level: number, samples: SampleSet = 'mechanical'): Tuning => ({ machine, category, hz, mesh, level, samples })

/** Level is a mix trim, not a claim about the real machine's acoustic SPL. */
export const TUNING: Record<string, Tuning> = {
  arm5: tune('servo', 'mechanism', 185, 7, 0.92),
  so101: tune('servo', 'mechanism', 265, 8, 0.72),
  six: tune('servo', 'mechanism', 115, 9, 1),
  scara: tune('servo', 'mechanism', 205, 6, 0.85),
  delta: tune('servo', 'mechanism', 295, 5, 0.72),
  desk: tune('servo', 'mechanism', 165, 6, 0.85),
  drone: tune('drone', 'flight', 190, 7, 0.85),
  helicopter: tune('helicopter', 'flight', 28, 9, 1),
  plane: tune('propeller', 'flight', 105, 4, 0.9),
  dog: tune('servo', 'mechanism', 155, 6, 0.85, 'feet'),
  rover: tune('drive', 'vehicle', 125, 6, 1),
  vacuum: tune('vacuum', 'household', 390, 3, 0.78, 'vacuum'),
  tank: tune('engine', 'vehicle', 42, 5, 1),
  excavator: tune('hydraulic', 'vehicle', 95, 7, 0.95),
  forklift: tune('hydraulic', 'vehicle', 145, 5, 0.9, 'wood'),
  boat: tune('engine', 'water', 57, 4, 0.9, 'none'),
  submarine: tune('drive', 'water', 85, 5, 1, 'none'),
  kart: tune('engine', 'vehicle', 72, 5, 0.85),
  slotcars: tune('drive', 'vehicle', 270, 4, 0.7),
  planetary: tune('drive', 'vehicle', 100, 7, 0.8),
  sorting: tune('drive', 'mechanism', 85, 5, 0.8),
  claw: tune('servo', 'mechanism', 175, 6, 0.85),
  ptz: tune('servo', 'mechanism', 210, 5, 0.58),
  gimbal: tune('servo', 'mechanism', 320, 3, 0.35),
  spotlights: tune('servo', 'mechanism', 130, 7, 0.58),
  telescope: tune('servo', 'mechanism', 110, 8, 0.5),
  slider: tune('drive', 'mechanism', 180, 5, 0.62),
  jib: tune('servo', 'mechanism', 90, 6, 0.52),
  smarthome: tune('fan', 'household', 120, 5, 0.5),
  lamp: tune('passive', 'passive', 95, 2, 0.45),
  painter: tune('scrape', 'table', 37, 2, 0.7, 'none'),
  pendulum: tune('passive', 'passive', 50, 2, 0.35, 'wood'),
  trebuchet: tune('scrape', 'table', 23, 3, 0.95, 'wood'),
  football: tune('scrape', 'table', 63, 2, 0.7, 'wood'),
  airhockey: tune('scrape', 'table', 45, 2, 0.7, 'wood'),
  pinball: tune('roll', 'table', 72, 4, 0.85),
  marblerun: tune('roll', 'table', 93, 3, 0.6, 'none'),
  maze: tune('roll', 'table', 78, 2, 0.55, 'wood'),
  arena: tune('roll', 'table', 48, 4, 0.9),
  viewer: tune('passive', 'passive', 95, 2, 0.4),
  studio: tune('passive', 'passive', 95, 2, 0, 'none'),
}

/** Reference programme targets, measured at the profile's reference distance. */
export const LOUDNESS_TARGETS: Record<Category, number> = {
  mechanism: -26, vehicle: -24, flight: -24, household: -28, table: -27, water: -27, passive: -32,
}

/** Untrimmed BS.1770 readings of the ten-second reference programme in AUDIO-3D.md. */
export const REFERENCE_LUFS: Record<string, number> = {
  rover: -19.16,
  drone: -21.91,
  maze: -33.30,
  ptz: -24.52,
  lamp: -29.21,
  claw: -21.06,
  boat: -19.73,
  spotlights: -23.96,
  vacuum: -23.49,
  tank: -19.44,
  excavator: -20.10,
  forklift: -20.38,
  painter: -31.69,
  gimbal: -29.03,
  plane: -20.87,
  slotcars: -23.12,
  dog: -24.33,
  sorting: -21.04,
  kart: -20.30,
  helicopter: -23.22,
  submarine: -19.12,
  smarthome: -26.63,
  airhockey: -32.48,
  pinball: -30.77,
  football: -25.07,
  marblerun: -32.84,
  planetary: -20.87,
  telescope: -25.11,
  pendulum: -28.21,
  trebuchet: -22.29,
  slider: -23.63,
  jib: -23.89,
  studio: -27.68,
  arena: -30.36,
  viewer: -30.18,
  arm5: -19.93,
  so101: -22.94,
  six: -19.22,
  scara: -21.03,
  delta: -22.25,
  desk: -20.99,
}

export function profileTrim(id: string) {
  const tuning = TUNING[id]
  if (!tuning.level) return 1
  const target = LOUDNESS_TARGETS[tuning.category] + 20 * Math.log10(tuning.level)
  return 10 ** (Math.max(-12, Math.min(8, target - REFERENCE_LUFS[id])) / 20)
}
