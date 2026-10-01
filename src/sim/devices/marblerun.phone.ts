/** Direct play uses the controller's screen-frame sensors and calibrated tilt, with a touch fallback. */
import { Mode } from '@obpal/core'
import { Motion, motionPermissionRequired, motionSupported, requestMotionPermission } from '../../controller/motion'
import { TiltStick } from '../../controller/gyro'
import { restInput } from './types'

export class MarblePhone {
  readonly motion = new Motion()
  private readonly tilt = new TiltStick()
  private allowed = false
  private denied = false
  private sampled = -Infinity
  private pending = true
  private recentred = false
  private drag: [number, number] = [0, 0]
  private presses: string[] = []
  private began = performance.now()
  constructor() {
    if (motionSupported() && !motionPermissionRequired()) this.listen()
  }
  private sample = (e: DeviceOrientationEvent) => {
    if (!this.allowed || document.hidden || e.beta == null || e.gamma == null || !this.motion.q) return
    if (![e.beta, e.gamma, e.alpha ?? 0].every(Number.isFinite)) return
    if (performance.now() - this.sampled > 1500) this.pending = true
    this.sampled = performance.now()
    if (this.pending) { this.tilt.capture(this.motion.up()); this.pending = false }
  }
  private listen() {
    if (this.allowed) return
    this.allowed = true; this.began = performance.now(); this.pending = true
    this.motion.start()
    window.addEventListener('deviceorientation', this.sample)
    screen.orientation?.addEventListener('change', this.defer)
    window.addEventListener('orientationchange', this.defer)
    document.addEventListener('visibilitychange', this.defer)
  }
  private defer = () => { this.pending = true; this.sampled = -Infinity; this.drag = [0, 0]; this.presses = [] }
  async enable() {
    if (!motionSupported()) return
    const permission = await requestMotionPermission()
    this.denied = permission === 'denied'
    if (permission === 'granted') this.listen()
  }
  get state() {
    if (!motionSupported()) return 'No motion sensor · drag'
    if (this.denied) return 'Motion denied · drag'
    if (!this.allowed) return 'Enable tilt'
    if (document.hidden || performance.now() - this.sampled > 1500) return performance.now() - this.began < 1500 ? 'Waiting for tilt · drag' : 'No tilt signal · drag'
    return 'Tilt active'
  }
  recenter() {
    if (this.motion.q) this.tilt.capture(this.motion.up())
    else this.pending = true
    this.recentred = true
  }
  move(x: number, y: number) { this.drag[0] += x; this.drag[1] += y }
  press(id: string) { this.presses.push(id) }
  read() {
    const input = restInput('face.trackpad', Mode.tilt)
    input.tilt = this.state === 'Tilt active' ? this.tilt.stick(this.motion.up()) : [0, 0]
    input.drag = this.drag; input.presses = this.presses; input.recentred = this.recentred
    this.drag = [0, 0]; this.presses = []; this.recentred = false
    return input
  }
  stop() {
    this.motion.stop(); window.removeEventListener('deviceorientation', this.sample)
    screen.orientation?.removeEventListener('change', this.defer)
    window.removeEventListener('orientationchange', this.defer)
    document.removeEventListener('visibilitychange', this.defer)
    this.allowed = false
  }
}
