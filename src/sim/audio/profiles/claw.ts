/** Claw sound follows its logic, independent of the rendered model. */
import type { ClawLogic } from '../../devices/claw'
import { profile, sample } from '../profile'

export default profile<ClawLogic>({
  id: 'claw', space: 'room', materials: ['glass', 'plastic'], texture: 'servo', pitch: 0.9, distance: 2, action: 'grab',
}, (logic, n, out) => {
  const u = logic.claws[n]
  sample(out, (n ? 1 : -1) + u.x, u.y, u.z, 0, 0, 0, 0, u.x, u.y, u.z, u.close)
})
