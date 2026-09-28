/** Forklift sound follows its logic, independent of the rendered model. */
import type { ForkliftLogic } from '../../devices/forklift'
import { profile, sample } from '../profile'

export default profile<ForkliftLogic>({
  id: 'forklift', space: 'hall', materials: ['metal', 'wood'], texture: 'hydraulic', pitch: 1.2, distance: 3, action: 'dock',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, 0.4, u.z, u.v / 3, u.load >= 0 ? 0.9 : 0.3, u.v / 3, 0, u.lift, u.tilt)
})

