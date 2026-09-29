/** Comfortable angular ranges shared by the phone and the sim. See spec/CONTROL-SPACE.md. */
export type ControlScope = 'object' | 'scene'
export type Reach = readonly [number, number]
export interface ControlSpace { reach: Reach; kind: 'point' | 'tilt' | 'drive' | 'tool' | 'music' | 'settings' }
const space = (kind: ControlSpace['kind'], x = 35, y = 25): ControlSpace => ({ kind, reach: [x, y] })
export const CONTROL_SPACES: Record<string, ControlSpace> = {
  'arm-arm5': space('tool'), 'arm-so101': space('tool'), 'arm-six': space('tool'),
  'arm-scara': space('tool'), 'arm-delta': space('tool', 30), 'arm-desk': space('tool', 30),
  rover: space('drive', 30), drone: space('drive', 30), maze: space('tilt', 20, 20), ptz: space('point'),
  lamp: space('settings', 30), claw: space('point'), studio: space('music'), boat: space('drive', 30),
  spotlights: space('point'), vacuum: space('drive', 30), tank: space('drive'), excavator: space('settings', 30),
  forklift: space('drive', 30), painter: space('point'), gimbal: space('point'), plane: space('drive', 30),
  slotcars: space('settings', 25, 20), dog: space('drive', 30), sorting: space('point', 30), kart: space('drive', 30),
  helicopter: space('drive', 30), submarine: space('drive', 30), smarthome: space('settings', 30),
  airhockey: space('point', 30), pinball: space('tilt', 18, 18), football: space('settings', 25, 20),
  marblerun: space('tilt', 20, 20), planetary: space('drive', 30), telescope: space('point'),
  pendulum: space('tilt', 25, 20), trebuchet: space('settings', 30), slider: space('point'), jib: space('point'),
  arena: space('tilt', 25, 25), humanoid: space('tilt', 25, 25), viewer: space('tool'),
}
export const unit = (n: number) => Math.max(-1, Math.min(1, Number.isFinite(n) ? n : 0))
/** Dead zone in degrees, with continuous full travel beyond it. */
export function reachAxis(degrees: number, range: number, dead = 0): number {
  if (!Number.isFinite(degrees) || range <= dead) return 0
  return Math.sign(degrees) * Math.max(0, unit((Math.abs(degrees) - dead) / (range - dead)))
}
export function reachOf(angles: Reach, range: Reach, dead = 0): [number, number] {
  return [reachAxis(angles[0], range[0], dead), reachAxis(angles[1], range[1], dead)]
}
export interface ControlAim { aim: [number, number]; tilt: [number, number]; active: boolean; pointer?: boolean }
export function readControlAim(value: unknown): ControlAim | null {
  if (typeof value !== 'string' || value.length > 160) return null
  try {
    const v = JSON.parse(value) as ControlAim
    if (typeof v.active !== 'boolean' || ![v.aim, v.tilt].every(a => Array.isArray(a) && a.length === 2 && a.every(n => Number.isFinite(n) && Math.abs(n) <= 1))) return null
    if (v.pointer !== undefined && typeof v.pointer !== 'boolean') return null
    return v
  } catch { return null }
}
/** Scene cells leave a margin and keep every target equally easy to acquire. */
export function sceneCells(count: number): [number, number][] {
  const cols = Math.min(count, Math.ceil(Math.sqrt(count * 1.5))), rows = Math.ceil(count / cols)
  return Array.from({ length: count }, (_, n) => {
    const row = Math.floor(n / cols), width = Math.min(cols, count - row * cols)
    return [width === 1 ? 0 : (n % cols - (width - 1) / 2) * 1.44 / (cols - 1), rows === 1 ? 0 : 0.62 - row * 1.24 / (rows - 1)]
  })
}
export function nearest<T extends { x: number; y: number }>(targets: readonly T[], aim: Reach): T {
  return targets.reduce((a, b) => Math.hypot(b.x - aim[0], b.y - aim[1]) < Math.hypot(a.x - aim[0], a.y - aim[1]) ? b : a)
}
