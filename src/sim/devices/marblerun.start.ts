/** The feeder releases three resting spheres; contacts and the cup do all subsequent placement. */
export interface MarbleStart { elapsed: number; phase: 'feeding' | 'settling' | 'settled' | 'controlled' }
export const startState = (calm = false): MarbleStart => ({ elapsed: 0, phase: calm ? 'settled' : 'feeding' })
export const releaseTime = (id: number) => id * .24
export function advanceStart(start: MarbleStart, dt: number, resting: boolean) {
  if (start.phase === 'settled' || start.phase === 'controlled') return
  start.elapsed += dt
  if (start.phase === 'feeding' && start.elapsed >= releaseTime(2)) start.phase = 'settling'
  if (start.phase === 'settling' && start.elapsed >= 1.5 && resting) start.phase = 'settled'
}
