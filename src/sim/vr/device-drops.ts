import type { DeviceLogic } from '../devices/types'
import { CABINETS, CLAW, ClawLogic, type Prize } from '../devices/claw'
import { marblePosition, MarblerunLogic, RUN, type Marble } from '../devices/marblerun'
import type { SharedPresence } from './presence'
import { distance, type V3 } from './world'
import type { DropObject } from './drops'

/** Scoring props retain the sim's own engine, while their shared mesh and credit use the normal props stream. */
export function deviceDrops(logic: DeviceLogic, getShared: () => SharedPresence) {
  const removals = new Map<string, () => void>()
  const alive = new Map<string, () => boolean>()
  let marbleId = 1000
  return {
    dropPosition(object: DropObject, requested: V3 | null, near?: V3): V3 | null {
      if (logic instanceof MarblerunLogic) {
        const board = Math.max(0, Math.min(logic.units.length - 1, Math.round((near?.[0] ?? 0) / 3.8)))
        const p: V3 = requested ? [...requested] : [board * 3.8, 0, .6]
        const n = Math.max(0, Math.min(logic.units.length - 1, Math.round(p[0] / 3.8)))
        if (Math.abs(p[0] - n * 3.8) > RUN.half - object.radius || Math.abs(p[2]) > RUN.half - object.radius) return null
        p[1] = .9 + object.radius + .025
        return p
      }
      if (logic instanceof ClawLogic) {
        const cabinet = CABINETS.reduce((best, at) => Math.abs(at[0] - (near?.[0] ?? CABINETS[0][0])) < Math.abs(best[0] - (near?.[0] ?? CABINETS[0][0])) ? at : best)
        const p: V3 = requested ? [...requested] : [cabinet[0], 0, cabinet[1] - .3]
        const n = CABINETS.findIndex(([x, z]) => Math.abs(p[0] - x) < CLAW.half - object.radius && Math.abs(p[2] - z) < CLAW.half - object.radius)
        if (n < 0) return null
        p[1] = CLAW.top - object.radius - .1
        return p
      }
      const first = getShared().adapter.rides()[0]?.pose().p
      return requested ?? [first?.x ?? 0, object.radius + .3, (first?.z ?? 0) - 1.5]
    },
    placeDrop(object: DropObject, at: V3) {
      const shared = getShared()
      if (logic instanceof MarblerunLogic) {
        const n = Math.max(0, Math.min(logic.units.length - 1, Math.round(at[0] / 3.8))), u = logic.units[n]
        const m: Marble = { id: ++marbleId, x: at[0] - n * 3.8, z: at[2], vx: 0, vz: 0, radius: object.radius, mass: 2500 * 4 / 3 * Math.PI * object.radius ** 3, detune: 0, spinX: 0, spinZ: 0, rollX: 0, rollZ: 0, slip: 0, normalForce: 0 }
        if ([u, ...u.marbles].some(other => Math.hypot(other.x - m.x, other.z - m.z) < other.radius + m.radius + .025)) return null
        u.marbles.push(m)
        const b = shared.world.add('ball', marblePosition(n, m, u.tiltX, u.tiltZ), m.radius, { read: () => marblePosition(n, m, u.tiltX, u.tiltZ), write: (p, v) => { m.x = p[0] - n * 3.8; m.z = p[2]; m.vx = v[0]; m.vz = v[2] } })
        b.rendered = true
        removals.set(b.id, () => { const index = u.marbles.indexOf(m); if (index >= 0) u.marbles.splice(index, 1) })
        alive.set(b.id, () => logic.units[n].marbles.includes(m))
        return b
      }
      if (logic instanceof ClawLogic) {
        const n = CABINETS.findIndex(([x, z]) => Math.abs(at[0] - x) < CLAW.half && Math.abs(at[2] - z) < CLAW.half)
        if (n < 0) return null
        const [x, z] = CABINETS[n], p: Prize = { x: at[0] - x, y: at[1], z: at[2] - z, r: object.radius, kind: object.id === 'orb' ? 'orb' : 'cube', color: '#79b9be', held: false, won: 0 }
        if (logic.prizes[n].some(other => distance([other.x, other.y, other.z], [p.x, p.y, p.z]) < other.r + p.r + .025)) return null
        logic.prizes[n].push(p)
        const b = shared.world.add(object.kind, at, p.r, { read: () => [p.x + x, p.y, p.z + z], write: (at, v) => { p.x = at[0] - x; p.y = at[1]; p.z = at[2] - z; void v }, busy: () => p.held })
        b.rendered = true
        removals.set(b.id, () => { const index = logic.prizes[n].indexOf(p); if (index < 0) return; if (logic.claws[n].held === index) logic.claws[n].held = -1; else if (logic.claws[n].held > index) logic.claws[n].held--; logic.prizes[n].splice(index, 1) })
        alive.set(b.id, () => logic.prizes[n].includes(p))
        return b
      }
      return shared.world.add(object.kind, at, object.radius)
    },
    dropAlive(id: string) { return alive.get(id)?.() ?? true },
    removeDrop(id: string) { removals.get(id)?.(); removals.delete(id); alive.delete(id) },
  }
}
