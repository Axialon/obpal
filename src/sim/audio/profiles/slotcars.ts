/** Slotcars sound follows its logic, independent of the rendered model. */
import type { SlotcarsLogic } from '../../devices/slotcars'
import { profile, sample } from '../profile'

export default profile<SlotcarsLogic>({
  id: 'slotcars', space: 'hall', materials: ['plastic', 'metal'], texture: 'motor', pitch: 2.3, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, u.y, u.z, u.off ? 0 : u.v / 5, u.v / 5, u.off ? 0 : u.v / 5)
})

