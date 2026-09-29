import { CameraHandMotion, type CameraHand } from '../../ui/hand-control'

/** Camera hands retain the arm's held deadman. After Stop, a fresh press is required. */
export class ArmHandInput {
  private motion = new CameraHandMotion()
  private released = true

  reset() { this.motion.reset() }
  stop() { this.reset(); this.released = false }

  step(hand: CameraHand | null, held: boolean, who: string) {
    if (!held) { this.released = true; this.reset(); return null }
    if (!this.released) return null
    return this.motion.step(hand, who)
  }
}
