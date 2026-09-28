/** Excavator sound follows its logic, independent of the rendered model. */
import type { ExcavatorLogic } from '../../devices/excavator'
import { profile, sample } from '../profile'

export default profile<ExcavatorLogic>({
  id: 'excavator', space: 'yard', materials: ['metal', 'wood'], texture: 'hydraulic', pitch: 0.75, distance: 4, action: 'grab',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, 1.2, u.z, 0, u.load / 5, 0, 0, u.swing, u.boom, u.stick, u.curl)
})

