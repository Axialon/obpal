/** Independent W3C fixtures: physical turns in a fixed, gravity-up camera frame. */
import { Euler, Quaternion, Vector3 } from 'three'

export const D = Math.PI / 180
export const axes = { pitch: [1, 0, 0], yaw: [0, 1, 0], roll: [0, 0, 1] }
export const holds = [
  { name: 'portrait', beta: 60, screen: 0 },
  { name: 'landscape-left', beta: 60, screen: 90 },
  { name: 'landscape-right', beta: 60, screen: 270 },
  { name: 'flat', beta: 0, screen: 0 },
  { name: 'upright', beta: 90, screen: 0 },
]
const rotation = (axis, deg) => new Quaternion().setFromAxisAngle(new Vector3(...axis), deg * D)
export const base = () => new Quaternion().setFromEuler(new Euler(-0.42, -0.6, 0, 'XYZ'))
export const delta = (axis, deg) => rotation(axes[axis], deg)

/** The corresponding WebXR pose, already in y-up tracking coordinates. */
export function trackingPose(hold, axis = 'yaw', deg = 0, heading = 17) {
  const view = rotation([0, 1, 0], heading)
  const neutral = view.clone().multiply(rotation([1, 0, 0], hold.beta - 90))
  return view.clone().multiply(delta(axis, deg)).multiply(view.clone().invert()).multiply(neutral).toArray()
}

/** An AR pose provider: exercise the real tracker and POSE transport without claiming camera hardware coverage. */
export function cameraPoseFixture() {
  localStorage.setItem('obpal.track3d', 'xr')
  window.__fakePose = { p: [0, 0, 0], q: [0, 0, 0, 1] }
  class Session extends EventTarget {
    renderState = { baseLayer: null }
    updateRenderState(state) { Object.assign(this.renderState, state) }
    async requestReferenceSpace() { return {} }
    requestAnimationFrame(callback) {
      return setTimeout(() => callback(performance.now(), { getViewerPose: () => {
        const { p, q } = window.__fakePose
        return { transform: { position: { x: p[0], y: p[1], z: p[2] }, orientation: { x: q[0], y: q[1], z: q[2], w: q[3] } }, emulatedPosition: false }
      } }), 16)
    }
    async end() { this.dispatchEvent(new Event('end')) }
  }
  Object.defineProperty(navigator, 'xr', { configurable: true, value: { isSessionSupported: async mode => mode === 'immersive-ar', requestSession: async () => new Session() } })
  window.XRWebGLLayer = class { framebuffer = null }
}

/** Device angles for a physical camera-axis turn, independent of the production conversion. */
export function reading(hold, axis = 'yaw', deg = 0, heading = 17) {
  const view = rotation([0, 0, 1], heading).multiply(rotation([1, 0, 0], 90))
  const neutral = rotation([0, 0, 1], heading).multiply(rotation([1, 0, 0], hold.beta))
  const q = view.clone().multiply(delta(axis, deg)).multiply(view.clone().invert()).multiply(neutral).multiply(rotation([0, 0, 1], hold.screen))
  return deviceAngles(q)
}

function deviceAngles(q) {
  const e = new Euler().setFromQuaternion(q, 'ZXY')
  let a = e.z / D, b = e.x / D, g = e.y / D
  if (Math.abs(g) > 90) { a += 180; b = b >= 0 ? 180 - b : -180 - b; g += g > 0 ? -180 : 180 }
  return { alpha: (a % 360 + 360) % 360, beta: (b + 180) % 360 - 180, gamma: Math.max(-90, Math.min(90 - 1e-8, g)) }
}

/** Specified tray slopes at any hold, expressed as real W3C sensor readings rather than Euler increments. */
export function trayReading(down, right, screen = 0, beta = 40) {
  const neutral = rotation([1, 0, 0], beta)
  const up = new Vector3(0, 0, 1).applyQuaternion(neutral.clone().invert())
  const rightAxis = new Vector3(1, 0, 0), forward = new Vector3().crossVectors(up, rightAxis)
  const tiltedUp = up.clone().addScaledVector(rightAxis, -Math.tan(right * D)).addScaledVector(forward, Math.tan(down * D)).normalize()
  const q = neutral.multiply(new Quaternion().setFromUnitVectors(tiltedUp, up)).multiply(rotation([0, 0, 1], screen))
  return deviceAngles(q)
}

export async function orient(cdp, r) {
  await cdp.send('DeviceOrientation.setDeviceOrientationOverride', r)
}

/** Orthographic axes and perspective vertices, using the same camera, not the application's quaternion. */
export function projection(q, size = [1, 1, 1], scale = 50) {
  const project = v => { const p = new Vector3(...v).applyQuaternion(q); return [p.x * scale / (1 - p.z * 0.16), -p.y * scale / (1 - p.z * 0.16)] }
  const vertices = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => project([x * size[0], y * size[1], z * size[2]]))))
  const lines = Object.values(axes).map(a => project(a))
  return { vertices, lines }
}
