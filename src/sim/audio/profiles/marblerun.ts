/** Marblerun sound follows its logic, independent of the rendered model. */
import type { MarblerunLogic } from '../../devices/marblerun'
import { profile, sample } from '../profile'

export default profile<MarblerunLogic>({
  id: 'marblerun', space: 'room', materials: ['glass', 'plastic'], texture: 'roll', pitch: 1, distance: 3, action: 'launch',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, n * 3.8 + u.x, 0.9, u.z, 0, 0, u.running ? Math.hypot(u.vx, u.vz) : 0)
})

