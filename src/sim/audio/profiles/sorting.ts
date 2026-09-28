/** Sorting sound follows its logic, independent of the rendered model. */
import type { SortingLogic } from '../../devices/sorting'
import { profile, sample } from '../profile'

export default profile<SortingLogic>({
  id: 'sorting', space: 'hall', materials: ['plastic', 'metal'], texture: 'motor', pitch: 0.7, distance: 3, action: 'dock',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, (n - 0.5) * 4.2 + u.x, 1, 0, u.active ? 0.4 : 0, u.active ? 0.5 : 0, 0, 0, u.push, u.x)
})

