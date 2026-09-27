/** Pickable stock and fixed workholding, shared by the workbench and its collision model. */
import type { Blk } from './blocks'
import type { V3 } from './grasp'

export interface Stock { half: V3; mass: number; color: string; shape: 'box' | 'drum' }
export const STOCK: readonly Stock[] = [
  ...['#7cabb2', '#cb8a7b', '#c6b273', '#9498b3', '#86aa91', '#b992a8'].map(color => ({ half: [0.03, 0.03, 0.03] as V3, mass: 0.025, color, shape: 'box' as const })),
  { half: [0.024, 0.045, 0.024], mass: 0.09, color: '#aab5bd', shape: 'drum' },
  { half: [0.024, 0.045, 0.024], mass: 0.09, color: '#aab5bd', shape: 'drum' },
  { half: [0.025, 0.018, 0.055], mass: 0.018, color: '#b79569', shape: 'box' },
  { half: [0.025, 0.018, 0.055], mass: 0.018, color: '#b79569', shape: 'box' },
  { half: [0.036, 0.022, 0.036], mass: 0.012, color: '#c6ff34', shape: 'box' },
  { half: [0.036, 0.022, 0.036], mass: 0.012, color: '#c6ff34', shape: 'box' },
]

/** Simulated payloads ease the motors' speed, without changing any real-arm command. */
export const payloadSpeed = (mass: number) => 1 / (1 + Math.max(0, mass) * 3)

export interface Fixture extends Blk { finish: 'bin' | 'shelf' | 'peg' }
export function fixtures(stand: number): Fixture[] {
  const out: Fixture[] = []
  const put = (x: number, y: number, z: number, half: V3, finish: Fixture['finish']) => out.push({ x, y, z, half, yaw: 0, finish })
  const width = stand * 0.3, depth = stand * 0.24, z = stand * 0.4
  for (const side of [-1, 1]) {
    const x = side * stand * 0.22
    // Sorting trays have an open front and flush floor, so fingers can enter them.
    put(x, 0.004, z, [width / 2, 0.004, depth / 2], 'bin')
    put(x, 0.026, z + depth / 2, [width / 2, 0.026, 0.006], 'bin')
    for (const edge of [-1, 1]) put(x + edge * width / 2, 0.026, z, [0.006, 0.026, depth / 2], 'bin')
  }
  const back = -stand * 0.42
  put(0, 0.105, back, [stand * 0.26, 0.012, stand * 0.11], 'shelf')
  for (const side of [-1, 1]) put(side * stand * 0.23, 0.047, back, [0.012, 0.047, stand * 0.09], 'shelf')
  for (const side of [-1, 1]) put(side * stand * 0.32, 0.04, 0, [0.012, 0.04, 0.012], 'peg')
  return out
}
