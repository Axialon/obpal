/** Place an authored telescoping actuator between two live joint frames. */
import * as THREE from 'three'

export function telescoping(sleeve: THREE.Object3D, rod: THREE.Object3D, tipFrame: THREE.Object3D, base: THREE.Vector3, tip: THREE.Vector3, inset = .026, rodLength = .07) {
  const end = new THREE.Vector3(), axis = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
  return () => {
    const parent = sleeve.parent!
    parent.updateWorldMatrix(true, false); tipFrame.updateWorldMatrix(true, false)
    end.copy(tip).applyMatrix4(tipFrame.matrixWorld); parent.worldToLocal(end)
    axis.subVectors(end, base)
    const length = axis.length()
    axis.normalize()
    sleeve.position.copy(base); sleeve.quaternion.setFromUnitVectors(up, axis)
    rod.position.copy(base).addScaledVector(axis, inset); rod.quaternion.copy(sleeve.quaternion)
    rod.scale.y = Math.max(.001, length - inset) / rodLength
  }
}
