/**
 * An arm moving by itself, for a card that shows its kind (./kinds.ts: ARM_KINDS[i].preview): its model, a block, and
 * a loop of pick and place between two spots in front of it, each pose solved as Point solves it (./kin.ts).
 */
import * as THREE from 'three'
import { openingFor } from './grasp'
import { homeOf, reachDown, type Pose } from './kin'
import { KINDS } from './kind'
import type { ArmKindId, ArmPreview } from './kinds'

const smooth = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c) }

/** A step of the loop: where the tool heads (the spot, 0 or 1; low or up), the gripper (0 open, 1 closed) and how long it takes (s). */
type Leg = [spot: number, low: number, grip: number, seconds: number]
// Over the block, down, grip, up, across, down, let go, up; then back the other way.
const across = (from: number, to: number): Leg[] => [
  [from, 0, 0, 1], [from, 1, 0, 0.7], [from, 1, 1, 0.35], [from, 0, 1, 0.7],
  [to, 0, 1, 1.3], [to, 1, 1, 0.7], [to, 1, 0, 0.35], [to, 0, 0, 0.7],
]
const LOOP = [...across(0, 1), ...across(1, 0)]
const LOOP_S = LOOP.reduce((s, l) => s + l[3], 0)

const BLOCK = 0.06

export function armPreview(id: ArmKindId): ArmPreview {
  const kind = KINDS[id]
  const kin = kind.kin
  const mats = {
    metal: new THREE.MeshStandardMaterial({ color: '#c9d1dc', metalness: 0.85, roughness: 0.28 }),
    dark: new THREE.MeshStandardMaterial({ color: '#1b2029', metalness: 0.6, roughness: 0.45 }),
  }
  const model = kind.build(1, mats)
  // No number on a card.
  model.root.traverse((o) => { if ((o as THREE.Sprite).isSprite) o.visible = false })
  const object = new THREE.Group()
  object.add(model.root)
  const blockMat = new THREE.MeshStandardMaterial({ color: '#c6ff34', emissive: '#c6ff34', emissiveIntensity: 0.15, roughness: 0.4 })
  const block = new THREE.Mesh(new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK), blockMat)
  object.add(block)
  // Two spots in front of it, either side, where it reaches comfortably.
  const reach = Math.min(kind.drive.reach[1] * 0.8, Math.max(kind.drive.reach[0] + 0.05, kind.cell.stand * 0.75))
  const spots = [-32, 32].map((yaw) => ({ yaw, x: -reach * Math.cos((yaw * Math.PI) / 180), z: reach * Math.sin((yaw * Math.PI) / 180) }))
  const high = kind.drive.hover[0] + 0.07
  const held = openingFor(BLOCK / 2)
  let pose: Pose = homeOf(kin)
  const put = (p: Pose, open: number) => {
    kin.keys.forEach((k, i) => model.apply[i](p[k]))
    model.apply[kin.keys.length](open)
  }
  put(pose, 1)
  const box = new THREE.Box3().setFromObject(model.root)
  const where = new THREE.Vector3()
  let at = 0
  return {
    object,
    size: { height: box.max.y, reach: reach + 0.1 },
    step(t) {
      let tt = ((t % LOOP_S) + LOOP_S) % LOOP_S
      let prev = LOOP[LOOP.length - 1], leg = LOOP[0]
      for (const l of LOOP) { if (tt <= l[3]) { leg = l; break } tt -= l[3]; prev = l }
      const k = smooth(tt / leg[3])
      const mix = (i: 0 | 1 | 2) => prev[i] + (leg[i] - prev[i]) * k
      // Along a circle about the arm between the spots, down and up at them.
      const s = mix(0), low = mix(1), grip = mix(2)
      const yaw = spots[0].yaw + (spots[1].yaw - spots[0].yaw) * s
      const height = high + (0.035 - high) * low
      const r = reachDown(kin, yaw, reach, height, 0, null, pose)
      if (r) pose = r.pose
      put(pose, 1 + (held - 1) * grip)
      // The block rides in the gripper once it's closed on it; else it sits on the spot it was last put down on.
      if (grip > 0.95) {
        model.grasp.getWorldPosition(where)
        object.worldToLocal(where)
        block.position.copy(where)
        block.quaternion.identity()
        at = s > 0.5 ? 1 : 0
      } else {
        const spot = spots[grip > 0.05 ? (s > 0.5 ? 1 : 0) : at]
        block.position.set(spot.x, BLOCK / 2, spot.z)
      }
      object.updateMatrixWorld()
    },
    dispose() {
      // Its materials too: the kind's own, which its arms in a sim share, are this preview's alone.
      const used = new Set<THREE.Material>()
      object.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) for (const x of Array.isArray(m) ? m : [m]) used.add(x) })
      model.dispose()
      block.geometry.dispose()
      for (const m of used) if (!m.userData.simShared) m.dispose()
      object.removeFromParent()
    },
  }
}
