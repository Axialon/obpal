/** Vacuum sound follows its logic, independent of the rendered model. */
import type { VacuumLogic } from '../../devices/vacuum'
import { profile, sample } from '../profile'

export default profile<VacuumLogic>({
  id: 'vacuum', space: 'room', materials: ['plastic', 'tile'], texture: 'motor', pitch: 2, distance: 3, action: 'dock',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, 0.15, u.z, u.clean && !u.docked ? 0.6 : Math.abs(u.v), u.v, u.v)
})

