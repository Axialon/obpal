/** Dog sound follows its logic, independent of the rendered model. */
import type { DogLogic } from '../../devices/dog'
import { profile, sample } from '../profile'

export default profile<DogLogic>({
  id: 'dog', space: 'yard', materials: ['rubber', 'tile'], texture: 'servo', pitch: 0.75, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  const stride = u.stride * (1 - u.sit)
  sample(out, u.x, 0.4, u.z, stride * (0.3 + Math.abs(Math.cos(u.gait)) * 0.45), stride * (0.4 + Math.abs(Math.sin(u.gait)) * 0.45), 0, u.gait, u.sit)
})

