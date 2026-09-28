import { deviceScreenAngle, qAxisAngle, qConj, qRotate, quatFromDeviceOrientation, type Quat, type Vec3 } from '@obpal/core'

const D2R = Math.PI / 180

/** The screen's actual orientation angle (degrees, 0/90/180/270). */
export const actualScreenAngle = deviceScreenAngle

let lockedAngle: number | null = null
/** While the page counter-rotates to stay locked (./lock.ts), motion reads the angle it was locked at. */
export function setLockedScreenAngle(a: number | null) { lockedAngle = a }

/** The angle of the UI's frame: the locked angle while the page counter-rotates, else the screen's. */
export function screenAngle(): number { return lockedAngle ?? actualScreenAngle() }

/** Normalizes W3C motion events into a screen-frame orientation quaternion and gyro rates. */
export class Motion {
  /** Linear acceleration in the screen frame (m/s², gravity removed), or null where the phone doesn't report it. */
  accel: Vec3 | null = null
  q: Quat | null = null
  gyro: Vec3 = [0, 0, 0]
  hasOrientation = false
  hasGyro = false
  lastSample = 0
  sampleAt = 0
  onSample: ((dtMs: number) => void) | null = null
  private last = 0
  private reading: [number, number, number] | null = null
  private vectorScreen = 0

  /** Re-express the last sensor sample immediately when the UI frame changes, before any neutral is captured. */
  refreshScreen() {
    const angle = screenAngle()
    if (this.reading) this.q = quatFromDeviceOrientation(...this.reading, angle)
    if (angle !== this.vectorScreen) {
      const reframe = qAxisAngle(0, 0, 1, (angle - this.vectorScreen) * D2R)
      if (this.accel) this.accel = qRotate(reframe, this.accel)
      this.gyro = qRotate(reframe, this.gyro)
      this.vectorScreen = angle
    }
  }

  start() {
    window.addEventListener('deviceorientation', this.orient)
    window.addEventListener('devicemotion', this.motion)
    screen.orientation?.addEventListener('change', this.refresh)
    window.addEventListener('orientationchange', this.refresh)
  }

  stop() {
    window.removeEventListener('deviceorientation', this.orient)
    window.removeEventListener('devicemotion', this.motion)
    screen.orientation?.removeEventListener('change', this.refresh)
    window.removeEventListener('orientationchange', this.refresh)
  }

  /** World "up" expressed in the screen frame. */
  up(): Vec3 {
    return this.q ? qRotate(qConj(this.q), [0, 0, 1]) : [0, 1, 0]
  }

  get flowing() {
    return performance.now() - this.lastSample < 150
  }

  private orient = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null || ![e.alpha ?? 0, e.beta, e.gamma].every(Number.isFinite)) return
    this.hasOrientation = true
    this.reading = [e.alpha ?? 0, e.beta, e.gamma]
    this.refreshScreen()
  }

  private refresh = () => this.refreshScreen()

  private motion = (e: DeviceMotionEvent) => {
    // Linear acceleration (gravity removed), in the screen frame like the gyro: 3D pushes and pulls (./imu3d.ts).
    const a = e.acceleration
    this.refreshScreen()
    const frame = qAxisAngle(0, 0, 1, this.vectorScreen * D2R)
    this.accel = a && a.x != null ? qRotate(frame, [a.x, a.y ?? 0, a.z ?? 0]) : null
    const r = e.rotationRate
    if (r && (r.alpha != null || r.beta != null || r.gamma != null)) {
      this.hasGyro = true
      const device: Vec3 = [(r.beta ?? 0) * D2R, (r.gamma ?? 0) * D2R, (r.alpha ?? 0) * D2R]
      this.gyro = qRotate(frame, device)
    }
    const now = performance.now()
    this.sampleAt = Number.isFinite(e.timeStamp) && Math.abs(now - e.timeStamp) < 1000 ? e.timeStamp : now
    const dt = this.last ? Math.min(Math.max(now - this.last, 0), 50) : 16.7
    this.last = now
    this.lastSample = now
    this.onSample?.(dt)
  }
}

/**
 * Starts both W3C permission requests synchronously (must run inside a user gesture on iOS).
 * iOS 13+ and Chromium 152+ expose requestPermission; never use its presence to detect the platform.
 * Resolves 'prompt' when the browser needs a user gesture first.
 */
export function requestMotionPermission(): Promise<'granted' | 'denied' | 'prompt'> {
  type Req = { requestPermission?: () => Promise<string> }
  const calls: Promise<string>[] = []
  const dme = (window as unknown as { DeviceMotionEvent?: Req }).DeviceMotionEvent
  const doe = (window as unknown as { DeviceOrientationEvent?: Req }).DeviceOrientationEvent
  try {
    if (typeof dme?.requestPermission === 'function') calls.push(dme.requestPermission())
    if (typeof doe?.requestPermission === 'function') calls.push(doe.requestPermission())
  } catch {
    return Promise.resolve('prompt')
  }
  if (!calls.length) return Promise.resolve('granted')
  return Promise.all(calls).then(
    (r) => (r.every((x) => x === 'granted') ? 'granted' : 'denied'),
    () => 'prompt',
  )
}

export const motionSupported = () => typeof window !== 'undefined' && 'DeviceOrientationEvent' in window
