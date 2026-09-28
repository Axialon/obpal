/** Boat sound follows its logic, independent of the rendered model. */
import type { BoatLogic } from '../../devices/boat'
import { profile, sample } from '../profile'

export default profile<BoatLogic>({
  id: 'boat', space: 'yard', materials: ['water', 'wood'], texture: 'engine', pitch: 0.7, distance: 4, action: 'splash',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, 0.25, u.z, u.v / 3, u.v / 3, u.v / 3)
})

