/** Ptz sound follows its logic, independent of the rendered model. */
import type { PtzLogic } from '../../devices/ptz'
import { profile, sample } from '../profile'

export default profile<PtzLogic>({
  id: 'ptz', space: 'room', materials: ['plastic', 'metal'], texture: 'servo', pitch: 1.2, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.cams[n]
  sample(out, u.at[0], u.at[1], u.at[2], 0, 0, 0, 0, u.pan, u.tilt, u.zoom * 0.2)
})

