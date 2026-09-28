/** Maze sound follows its logic, independent of the rendered model. */
import type { MazeLogic } from '../../devices/maze'
import { profile, sample } from '../profile'

export default profile<MazeLogic>({
  id: 'maze', space: 'room', materials: ['glass', 'wood'], texture: 'roll', pitch: 1.2, distance: 2, action: 'tick',
}, (logic, n, out) => {
  const u = logic.boards[n]
  sample(out, (n % 2 ? 0.98 : -0.98) + u.mx, 0.2, (n < 2 ? -0.94 : 1) + u.mz, 0, 0, Math.hypot(u.vx, u.vz))
})
