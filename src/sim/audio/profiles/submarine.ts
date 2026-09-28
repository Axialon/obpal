/** Submarine sound follows its logic, independent of the rendered model. */
import type { SubmarineLogic } from '../../devices/submarine'
import { profile, sample } from '../profile'

export default profile<SubmarineLogic>({
  id: 'submarine', space: 'underwater', materials: ['metal', 'water'], texture: 'motor', pitch: 0.55, distance: 6, action: 'sonar',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, u.y, u.z, u.v / 2.5, u.thrust, u.v / 2.5)
})

