/** Octopus sound follows its logic: soft elastomer on tile, travel as the rolling channel, the mantle as load. */
import type { OctopusLogic } from '../../devices/octopus'
import { profile, sample } from '../profile'

export default profile<OctopusLogic>({
  id: 'octopus', space: 'room', materials: ['rubber', 'tile'], texture: 'servo', pitch: 0.6, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  if (!u) return sample(out, 0, 0, 0)
  const travel = Math.min(1, Math.abs(u.v) / 0.3 + Math.abs(u.turn) * 0.3)
  sample(out, u.x, u.y, u.z, travel * 0.5, 1 - u.mantle, travel, 0)
})
