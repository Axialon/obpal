import { Matrix4, Quaternion, Vector3 } from 'three'
import { HandGesture, type Quat, type Vec3 } from '@obpal/core'
import type { Frame } from '@obpal/host'

export type CameraHand = NonNullable<Frame['hand']>

/** The palm's across, finger and normal axes, from hand-centred landmarks in camera space. */
export function palmRotation(hand: CameraHand): Quat | null {
  const wrist = hand.landmarks[0], index = hand.landmarks[5], middle = hand.landmarks[9], pinky = hand.landmarks[17]
  if (!wrist || !index || !middle || !pinky) return null
  const x = new Vector3(...index).sub(new Vector3(...pinky))
  const y = new Vector3(...middle).sub(new Vector3(...wrist))
  const z = new Vector3().crossVectors(x, y)
  if (x.lengthSq() < 1e-8 || y.lengthSq() < 1e-8 || z.lengthSq() < 1e-12) return null
  x.normalize(); z.normalize(); y.crossVectors(z, x).normalize()
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z))
  return q.toArray().every(Number.isFinite) ? q.toArray() : null
}

export const handGrabs = (hand: CameraHand) => !!(hand.gestures & (HandGesture.pinch | HandGesture.grip))

export interface HandMove {
  /** Camera-space movement since the last sample: right, up, toward the camera, in metres. */
  delta: Vec3
  /** Camera-space turn since the last sample, and since this anchor began. */
  turn: Quat
  rotation: Quat
  started: boolean
  pinch: boolean
}

/** Tracking loss, a changed identity or a changed target starts a new anchor without moving it. */
export class CameraHandMotion {
  private anchor: { gen: number; key: string; p: Vec3; q: Quaternion; origin: Quaternion } | null = null

  reset() { this.anchor = null }

  step(hand: CameraHand | null, key: string | null): HandMove | null {
    const q = hand?.tracked ? palmRotation(hand) : null
    if (!hand || !q || key === null) { this.reset(); return null }
    const current = new Quaternion(...q)
    const started = !this.anchor || this.anchor.gen !== hand.gen || this.anchor.key !== key
    if (started) this.anchor = { gen: hand.gen, key, p: [...hand.p], q: current.clone(), origin: current.clone() }
    const a = this.anchor!
    const move: HandMove = {
      delta: [hand.p[0] - a.p[0], hand.p[1] - a.p[1], hand.p[2] - a.p[2]],
      turn: current.clone().multiply(a.q.clone().invert()).toArray(),
      rotation: current.clone().multiply(a.origin.clone().invert()).toArray(),
      started, pinch: !!(hand.gestures & HandGesture.pinch),
    }
    a.p = [...hand.p]; a.q.copy(current)
    return move
  }
}
