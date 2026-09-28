import type { PadState } from '@obpal/core'
import type { DeviceLogic, DeviceInput } from '../devices/types'
import { restInput } from '../devices/types'
import type { Stage } from '../devices/stage'
import type { DeviceView } from '../devices/view'
import type { SimScene } from '../scene'
import { captureDevice, applyDevice } from './snapshot'
import { deviceRides, deviceState } from './rigs'
import { SharedPresence } from './presence'
import { Experience } from './experience'
import type { V3 } from './world'
import { collideDevices } from './collisions'

/** Keep integration outside device models: rig anchors and the existing physics remain the source of truth. */
export function devicePresence(logic: DeviceLogic, stage: Stage, getView: () => DeviceView | null, getSim: () => SimScene | null) {
  const driving = new Map<number, { who: string; pad: PadState; last: number; previous: number }>()
  const phones = new Map<string, { grab: boolean; offset: V3 }>()
  const rides = () => deviceRides(logic, stage.scene, getView()?.anchor)
  const shared = new SharedPresence({
    capture: () => captureDevice(logic), apply: s => applyDevice(logic, s), rides,
    drive(who, ride, pad) {
      const sim = getSim(), n = rides().findIndex(r => r.id === ride)
      if (!sim || n < 0) return
      if (!sim.claims.holder(ride)) sim.take(ride, who)
      if (sim.claims.holder(ride) !== who) return
      driving.set(n, { who, pad, last: performance.now(), previous: driving.get(n)?.previous ?? 0 })
    },
    colliders: () => {
      const moving = ['drone', 'rover', 'kart', 'submarine', 'helicopter', 'boat', 'plane', 'tank', 'forklift', 'dog', 'vacuum', 'planetary']
      if (!moving.includes(logic.spec.id)) return []
      return rides().map((_, n) => {
        const u = deviceState(logic, n)
        return { p: [u.x, (u.y ?? 0) + 0.18, u.z] as V3, r: 0.32, move: (x: number, z: number) => { u.x += x; u.z += z } }
      })
    },
  })
  stage.scene.add(shared.group)
  const experience = new Experience(stage.renderer, stage.scene, stage.camera, rides, shared, stage.controls)
  stage.view.presence = experience
  if (!shared.guest) {
    const first = deviceState(logic, 0)
    const x = first.x ?? 0, z = first.z ?? 0
    // A small shared play set near the first ride; these props never alter a sim's scoring objects.
    shared.world.add('cone', [x + 0.55, 0.18, z - 1], 0.18)
    shared.world.add('ball', [x - 0.55, 0.16, z - 1.3], 0.16)
    shared.world.add('block', [x + 0.1, 0.16, z - 1.8], 0.16)
    const data = logic as unknown as { cones?: { x: number; z: number; vx: number; vz: number }[]; pallets?: { x: number; y: number; z: number; vy: number }[] }
    data.cones?.forEach(c => shared.world.add('cone', [c.x, 0.12, c.z], 0.12, {
      read: () => [c.x, 0.12, c.z], write: (p, v) => { c.x = p[0]; c.z = p[2]; c.vx = v[0]; c.vz = v[2] },
    }))
    data.pallets?.forEach((p, n) => shared.world.add('pallet', [p.x, p.y, p.z], 0.18, {
      read: () => [p.x, p.y, p.z], write: (at, v) => { p.x = at[0]; p.y = at[1]; p.z = at[2]; p.vy = v[1] }, busy: () => deviceState(logic, 0).load === n,
    }))
  }
  return {
    shared, experience,
    afterStep: () => collideDevices(logic),
    connect(sim: SimScene) {
      shared.connect(sim.remote)
      sim.remote.on('button', (e, who) => {
        if (e.id !== 'scene-grab' || !['tap', 'down'].includes(e.ev)) return
        const p = phones.get(who.id) ?? { grab: false, offset: [0, 0, -0.7] as V3 }; p.grab = !p.grab; phones.set(who.id, p)
      })
      sim.remote.on('leave', who => phones.delete(who.id))
    },
    inputs(perUnit: (DeviceInput | null)[], inputs: Map<string, DeviceInput>) {
      const sim = getSim()
      for (const [n, d] of driving) {
        if (performance.now() - d.last > 300 || sim?.claims.holder(rides()[n].id) !== d.who) { driving.delete(n); continue }
        const input = restInput(); input.pad = d.pad; input.padPressed = d.pad.buttons & ~d.previous; d.previous = d.pad.buttons
        perUnit[n] = input
      }
      for (const [who, inp] of inputs) {
        if (shared.isVisitor(who)) continue
        if (inp.quiet && !phones.has(who)) continue
        const p = phones.get(who) ?? { grab: false, offset: [0, 0, -0.7] as V3 }
        phones.set(who, p)
        const ride = sim?.claims.held(who)
        if (!ride || !inp || inp.quiet) { shared.world.release(who, false); p.grab = false; continue }
        if (p.grab) {
          p.offset[0] = Math.max(-0.7, Math.min(0.7, p.offset[0] + inp.drag[0] * 0.003))
          p.offset[1] = Math.max(-0.3, Math.min(0.8, p.offset[1] - inp.drag[1] * 0.003))
        }
        shared.phone(who, ride, p.grab, p.offset)
      }
      shared.colors = rides().map(r => { const who = sim?.claims.holder(r.id); return who ? sim!.colorOf(who) : null })
    },
  }
}
