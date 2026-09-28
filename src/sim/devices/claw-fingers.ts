/** Fit the rendered fingers to the actual prize envelope, including a cube's orientation. */
import * as THREE from 'three'
import { boxPenetration, geometryBox } from '../contact-box'
import type { Prize } from './claw'

const cube = new THREE.BoxGeometry(2, 2, 2)
export function fingerPenetration(fingers: readonly THREE.Object3D[], root: THREE.Object3D, prizes: readonly Prize[]) {
  root.updateWorldMatrix(true, true)
  let depth = 0
  for (const f of fingers) f.traverse(part => {
    const mesh = part as THREE.Mesh
    if (!mesh.isMesh) return
    const box = geometryBox(mesh.geometry, mesh.matrixWorld)
    for (const [k, prize] of prizes.entries()) {
      if (prize.won) continue
      const centre = new THREE.Vector3(prize.x, prize.y, prize.z).applyMatrix4(root.matrixWorld)
      if (centre.distanceToSquared(box.centre) > .09) continue
      if (prize.kind === 'orb') {
        const delta = centre.clone().sub(box.centre)
        const distance = Math.sqrt(box.axes.reduce((sum, axis, i) => sum + Math.max(0, Math.abs(delta.dot(axis)) - box.half[i]) ** 2, 0))
        depth = Math.max(depth, prize.r - distance)
      } else {
        const pose = new THREE.Matrix4().compose(new THREE.Vector3(prize.x, prize.y, prize.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), k * .7), new THREE.Vector3().setScalar(prize.r))
        depth = Math.max(depth, boxPenetration(box, geometryBox(cube, root.matrixWorld.clone().multiply(pose))))
      }
    }
  })
  return depth
}

export function fitFingers(fingers: readonly THREE.Object3D[], root: THREE.Object3D, prizes: readonly Prize[], close: number) {
  const at = (amount: number) => { for (const f of fingers) f.rotation.z = .75 - amount * .95 }
  at(close)
  if (fingerPenetration(fingers, root, prizes) <= .0001) return
  let lo = 0, hi = close
  for (let n = 0; n < 12; n++) {
    const mid = (lo + hi) / 2; at(mid)
    if (fingerPenetration(fingers, root, prizes) <= .0001) lo = mid
    else hi = mid
  }
  at(lo)
}
