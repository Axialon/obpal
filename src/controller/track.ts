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
  /** Counts tracking origins: a session or recenter establishes a new one for the host. */
  gen = 0
  onPose?: (p: Vec3, q: Quat, tracked: boolean) => void
  onEnd?: () => void

  constructor(private nextGen: () => number = () => this.gen + 1) {}

  static async supported(): Promise<boolean> {
    try { return !!(await xr()?.isSessionSupported('immersive-ar')) } catch { return false }
  }

  get active() { return !!this.session }

  /** The next pose starts a fresh host reference while the camera keeps tracking the same space. */
  recenter() { this.gen = this.nextGen() }

  /**
   * Start tracking; call from a tap. `overlay` stays on screen over the camera view. Rejects when it can't start; a
   * start that fails part way ends the session it began, so the next tap can try again.
   */
  async start(overlay: HTMLElement) {
    const system = xr()
    if (!system) throw new Error('No WebXR here')
    if (this.session) return
    const session = await system.requestSession('immersive-ar', { requiredFeatures: ['local'], optionalFeatures: ['dom-overlay'], domOverlay: { root: overlay } } as XRSessionInit)
    this.session = session
    session.addEventListener('end', () => { if (this.session !== session) return; this.session = null; this.onEnd?.() })
    let space: XRReferenceSpace
    let gl: WebGLRenderingContext
    try {
      this.recenter()
      // Nothing is drawn: a cleared, transparent layer shows the camera.
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('webgl2', { xrCompatible: true, alpha: true }) ?? canvas.getContext('webgl', { xrCompatible: true, alpha: true })
      if (!context) throw new Error('No WebGL for the camera view')
      gl = context as WebGLRenderingContext
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) })
      space = await session.requestReferenceSpace('local')
    } catch (e) {
      this.session = null
      await session.end().catch(() => {})
      throw e
    }
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
