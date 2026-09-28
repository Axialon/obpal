/** Lamp sound follows its logic, independent of the rendered model. */
import type { LampLogic } from '../../devices/lamp'
import { profile, sample } from '../profile'

const positions = [[-1.05, 1.8, -1.3], [1.6, 0.98, -1.5], [0.25, 1.46, -0.35], [1.05, 1.7, -2.28]]

export default profile<LampLogic>({
  id: 'lamp', space: 'room', materials: ['glass', 'plastic'], texture: 'servo', pitch: 0.7, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const p = positions[n]
  sample(out, p[0], p[1], p[2], 0, Number(logic.lamps[n].on))
})
