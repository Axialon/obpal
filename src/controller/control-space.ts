/** One neutral for pointing, steering and music, independent of the selected phone face. */
import type { Motion } from './motion'
import { WiiPointer } from './pointing'
import { TiltStick } from './gyro'
import { CONTROL_SPACES, reachOf, type ControlAim, type ControlScope } from '../control-space'

export class CalibratedControl {
  sim = ''
  scope: ControlScope = 'object'
  private pointer = new WiiPointer()
  private tilt = new TiltStick()
  private pending = true
  private pendingQ: Motion['q'] = null
  constructor(private motion: Motion) {}
  /** A waking sensor must deliver a new orientation before its old cached pose can become neutral. */
  defer() { this.pending = true; this.pendingQ = this.motion.q }
  recenter() {
    if (this.pending && this.motion.q === this.pendingQ) return
    this.pending = !this.motion.q
    if (!this.motion.q) return
    this.pointer.recenter(this.motion.q)
    this.tilt.capture(this.motion.up())
  }
  sample(dt = 0.016): ControlAim {
    if (this.pending) this.recenter()
    if (this.pending) return { aim: [0, 0], tilt: [0, 0], active: false }
    if (this.motion.q) this.pointer.update(this.motion.q, dt)
    const range = CONTROL_SPACES[this.sim]?.reach ?? [35, 25]
    return { aim: reachOf(this.pointer.rawAim, range), tilt: reachOf(this.tilt.angles(this.motion.up()), range, 3), active: !!this.motion.q }
  }
}
