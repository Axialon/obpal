/**
 * 3D tracking (mode 6, catalogue `motion.track`): the phone follows itself through space with WebXR, in an
 * immersive-ar session (Android Chrome with Google Play Services for AR). Its camera keeps the position from
 * drifting, which motion sensors alone can't. The controls stay on screen over the camera view (the DOM overlay),
 * and each frame's pose goes to the host in a POSE packet.
 */
import type { Quat, Vec3 } from '@obpal/core'

const xr = () => (navigator as Navigator & { xr?: XRSystem }).xr

export class Tracker {
  private session: XRSession | null = null
  /** Counts tracking sessions: each has its own origin. */
  gen = 0
  onPose?: (p: Vec3, q: Quat, tracked: boolean) => void
  onEnd?: () => void

  static async supported(): Promise<boolean> {
    try { return !!(await xr()?.isSessionSupported('immersive-ar')) } catch { return false }
  }

  get active() { return !!this.session }

  /** Start tracking; call from a tap. `overlay` stays on screen over the camera view. */
  async start(overlay: HTMLElement) {
    const system = xr()
    if (!system || this.session) return
    const session = await system.requestSession('immersive-ar', { requiredFeatures: ['local'], optionalFeatures: ['dom-overlay'], domOverlay: { root: overlay } } as XRSessionInit)
    this.session = session
    this.gen = (this.gen + 1) & 0xff
    // Nothing is drawn: a cleared, transparent layer shows the camera.
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2', { xrCompatible: true, alpha: true }) ?? canvas.getContext('webgl', { xrCompatible: true, alpha: true })) as WebGLRenderingContext
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) })
    const space = await session.requestReferenceSpace('local')
    session.addEventListener('end', () => { this.session = null; this.onEnd?.() })
    let p: Vec3 = [0, 0, 0]
    let q: Quat = [0, 0, 0, 1]
    const frame = (_t: number, f: XRFrame) => {
      if (this.session !== session) return
      session.requestAnimationFrame(frame)
      gl.bindFramebuffer(gl.FRAMEBUFFER, session.renderState.baseLayer?.framebuffer ?? null)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      const pose = f.getViewerPose(space)
      if (pose) {
        const { position: a, orientation: o } = pose.transform
        p = [a.x, a.y, a.z]
        q = [o.x, o.y, o.z, o.w]
      }
      this.onPose?.(p, q, !!pose && !pose.emulatedPosition)
    }
    session.requestAnimationFrame(frame)
  }

  async stop() {
    const s = this.session
    if (s) await s.end().catch(() => {})
  }
}
