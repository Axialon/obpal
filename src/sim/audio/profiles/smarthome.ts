/** Smarthome sound follows its logic, independent of the rendered model. */
import type { SmarthomeLogic } from '../../devices/smarthome'
import { profile, sample } from '../profile'

const positions = [[-1.65, 1.8, -2.05], [0.1, 2.5, 0.15], [0.95, 1.5, -2.08], [2.6, 1.65, -2.08]]

export default profile<SmarthomeLogic>({
  id: 'smarthome', space: 'room', materials: ['plastic', 'wood'], texture: 'motor', pitch: 0.75, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  const p = positions[n]
  sample(out, p[0], p[1], p[2], n === 1 && u.on ? u.level : 0, 0, 0, 0, n === 2 ? u.level : 0)
})
