/** Gimbal sound follows its logic, independent of the rendered model. */
import type { GimbalLogic } from '../../devices/gimbal'
import { profile, sample } from '../profile'

export default profile<GimbalLogic>({
  id: 'gimbal', space: 'room', materials: ['plastic', 'metal'], texture: 'servo', pitch: 1.4, distance: 2, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, 0, 1.2, 0, 0, 0, 0, 0, u.pan, u.pitch, u.roll)
})

