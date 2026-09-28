/** Trebuchet sound follows its logic, independent of the rendered model. */
import type { TrebuchetLogic } from '../../devices/trebuchet'
import { profile, sample } from '../profile'

export default profile<TrebuchetLogic>({
  id: 'trebuchet', space: 'yard', materials: ['wood', 'tile'], texture: 'hydraulic', pitch: 0.4, distance: 5, action: 'launch',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, n * 5, u.y, u.z, 0, 0, 0, 0, u.arm)
})

