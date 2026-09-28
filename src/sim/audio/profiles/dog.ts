/** Dog sound follows its logic, independent of the rendered model. */
import type { DogLogic } from '../../devices/dog'
import { profile, sample } from '../profile'

export default profile<DogLogic>({
  id: 'dog', space: 'yard', materials: ['rubber', 'tile'], texture: 'servo', pitch: 0.75, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, 0.4, u.z, Math.abs(u.v) / 3, Math.abs(u.v) / 3, 0, u.gait)
})

