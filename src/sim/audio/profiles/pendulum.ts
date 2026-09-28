/** Pendulum sound follows its logic, independent of the rendered model. */
import type { PendulumLogic } from '../../devices/pendulum'
import { profile, sample } from '../profile'

export default profile<PendulumLogic>({
  id: 'pendulum', space: 'room', materials: ['metal', 'wood'], texture: 'servo', pitch: 0.35, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, (n - 1) * 1.65 + Math.sin(u.angle) * u.length, 2.9 - Math.cos(u.angle) * u.length, 0, Math.abs(u.omega) / 5)
})
