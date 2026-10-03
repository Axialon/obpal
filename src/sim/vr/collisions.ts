import type { DeviceLogic } from '../devices/types'
import { deviceState } from './rigs'

const moving = new Set(['rover', 'drone', 'boat', 'tank', 'forklift', 'dog', 'kart', 'helicopter', 'submarine', 'plane', 'vacuum', 'planetary', 'octopus'])
/** Fill gaps between units after their native physics; already separated native contacts need no correction. */
export function collideDevices(logic: DeviceLogic) {
  if (!moving.has(logic.spec.id)) return
  for (let i = 0; i < logic.spec.units; i++) for (let j = i + 1; j < logic.spec.units; j++) {
    const a = deviceState(logic, i), b = deviceState(logic, j)
    if (Math.abs((a.y ?? 0) - (b.y ?? 0)) > 0.5) continue
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz)
    if (d >= 0.6) continue
    const nx = d > 1e-5 ? dx / d : 1, nz = d > 1e-5 ? dz / d : 0, push = (0.6 - d) / 2
    a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push
    if ('v' in a) a.v *= 0.5
    if ('v' in b) b.v *= 0.5
    for (const u of [a, b]) { if ('vx' in u) u.vx *= 0.5; if ('vz' in u) u.vz *= 0.5 }
  }
}
