/** Jib sound follows its logic, independent of the rendered model. */
import type { JibLogic } from '../../devices/jib'
import { profile, sample } from '../profile'

export default profile<JibLogic>({
  id: 'jib', space: 'hall', materials: ['metal', 'plastic'], texture: 'servo', pitch: 0.6, distance: 4, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, n ? 2.2 : -2.2, 1.8, 1, 0, 0, 0, 0, u.swing, u.boom, u.pan, u.tilt)
})
