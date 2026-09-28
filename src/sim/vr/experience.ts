import * as THREE from 'three'
import { emptyPad } from '@obpal/core'
import type { Ride } from './rigs'
import { comfort, DEFAULT_COMFORT, vignetteStrength, XRQuality } from './comfort'
import type { SharedPresence, Pose } from './presence'
import type { V3 } from './world'
import '../../styles/presence.css'

export type ViewMode = 'overview' | 'first-person' | 'xr'
const UP = new THREE.Vector3(0, 1, 0)
const pose = (o: THREE.Object3D): Pose => ({ p: o.getWorldPosition(new THREE.Vector3()).toArray() as V3, q: o.getWorldQuaternion(new THREE.Quaternion()).toArray() })

/** One camera rig for desktop look, the phone magic window and WebXR. */
export class Experience extends EventTarget {
  readonly camera = new THREE.PerspectiveCamera(75, 1, 0.015, 300)
  readonly rig = new THREE.Group()
  readonly quality = new XRQuality()
  mode: ViewMode = 'overview'
  settings = { ...DEFAULT_COMFORT }
  ride = ''
  drive = false
  private yaw = 0
  private pitch = 0
  private gyro = new THREE.Quaternion()
  private gyroZero: THREE.Quaternion | null = null
  private sensor = false
  private grab = false
  private turning = false
  private lastPosition: THREE.Vector3 | null = null
  private lastYaw = 0
  private savedShadows = false
  private xrPending = false
  private emulated = false
  private controllerHands: THREE.Group[] = []
  private controllerSources: (XRInputSource | null)[] = [null, null]
  private grabbing = new Set<number>()
  private controls: HTMLDivElement
  private controlsHome: HTMLElement
  private soundHome: HTMLElement | null = null
  private picker: HTMLSelectElement
  private info: HTMLElement
  private leaveButton: HTMLButtonElement
  private overlay: HTMLDivElement
  private mask: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private exitTarget: THREE.Mesh
  private lastUI = -Infinity
  private observedFrames = 0
  private observedTime = 0
  constructor(readonly renderer: THREE.WebGLRenderer, readonly scene: THREE.Scene, readonly overview: THREE.PerspectiveCamera, readonly rides: () => Ride[], readonly shared?: SharedPresence, private orbit?: { enabled: boolean }) {
    super()
    this.rig.name = 'presence-rig'
    this.rig.add(this.camera); scene.add(this.rig)
    renderer.xr.enabled = true
    renderer.xr.setReferenceSpaceType('local')
    renderer.xr.setFramebufferScaleFactor(0.85)
    renderer.xr.setFoveation(0.5)
    try { this.settings = comfort(JSON.parse(localStorage.getItem('obpal.comfort') ?? 'null')) } catch { /* private storage */ }
    this.overlay = document.createElement('div'); this.overlay.className = 'presence-shade'; document.body.append(this.overlay)
    const material = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false,
      uniforms: { strength: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=vec4(position.xy*2.0,0.0,1.0);}',
      fragmentShader: 'varying vec2 vUv; uniform float strength; void main(){float edge=smoothstep(0.25,0.7,length(vUv-0.5)); gl_FragColor=vec4(0.,0.,0.,edge*strength);}',
    })
    this.mask = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material); this.mask.frustumCulled = false; this.mask.renderOrder = 10000
    this.camera.add(this.mask)
    // A head-relative exit remains reachable when the runtime does not support DOM overlays.
    const c = document.createElement('canvas'); c.width = 256; c.height = 64
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#141923'; ctx.fillRect(0, 0, 256, 64); ctx.fillStyle = '#ffffff'; ctx.font = '24px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Overview', 128, 41)
    this.exitTarget = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.05), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }))
    this.exitTarget.position.set(0, -0.2, -0.5); this.exitTarget.renderOrder = 10001; this.camera.add(this.exitTarget)
    this.controls = document.createElement('div'); this.controls.className = 'presence-controls'; this.controls.setAttribute('aria-label', 'Scene viewpoint')
    this.controlsHome = document.querySelector<HTMLElement>('.sim-panel') ?? document.body
    this.controls.classList.toggle('presence-floating', this.controlsHome === document.body)
    const button = (label: string, action: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = action; if (!['First person', 'Enter VR', 'Share scene'].includes(label)) b.className = 'presence-extra'; this.controls.append(b); return b }
    this.picker = document.createElement('select'); this.picker.setAttribute('aria-label', 'Ride a device'); this.controls.append(this.picker)
    this.picker.onchange = () => { this.ride = this.picker.value; this.recenter() }
    button('First person', () => { this.setMode('first-person'); void this.startSensors() })
    const enter = button('Enter VR', () => { void this.enterXR() }); enter.disabled = true; enter.title = 'Checking VR support'
    void navigator.xr?.isSessionSupported('immersive-vr').then(ok => { enter.disabled = !ok; enter.title = ok ? 'Look around inside this scene' : 'This browser does not offer immersive VR' }).catch(() => { enter.title = 'VR is unavailable here' })
    if (!navigator.xr) enter.title = 'Use a WebXR headset browser to enter VR'
    this.leaveButton = button('Overview', () => { void this.leave() }); this.leaveButton.hidden = true
    button('Recenter', () => this.recenter())
    button('↶', () => this.snap(-1)).setAttribute('aria-label', 'Snap turn left')
    button('↷', () => this.snap(1)).setAttribute('aria-label', 'Snap turn right')
    const toggle = (label: string, checked: boolean, change: (v: boolean) => void) => {
      const l = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox'; box.checked = checked; box.onchange = () => change(box.checked); l.append(box, label); this.controls.append(l)
    }
    toggle('Horizon lock', this.settings.horizon, v => { this.settings.horizon = v; this.save() })
    toggle('Comfort shade', this.settings.vignette, v => { this.settings.vignette = v; this.save() })
    toggle('Drive with XR sticks', false, v => { this.drive = v })
    if (shared && !shared.guest) button('Share scene', () => { const url = shared.shareUrl(); if (url) { void navigator.clipboard?.writeText(url).then(() => { this.info.textContent = 'Scene link copied' }).catch(() => { this.showLink(url) }); this.showLink(url) } })
    if (shared) button('Grab / release', () => { this.grab = !this.grab })
    const stop = document.getElementById('estop')
    if (stop) button('Stop arms', () => shared?.guest ? shared.stopArms() : stop.click())
    this.info = document.createElement('small'); this.info.setAttribute('role', 'status'); this.controls.append(this.info)
    this.controlsHome.prepend(this.controls)
    this.bindLook()
    for (let n = 0; n < 2; n++) {
      const ray = renderer.xr.getController(n)
      const grip = renderer.xr.getControllerGrip(n)
      const hand = renderer.xr.getHand(n)
      this.rig.add(ray, grip, hand)
      this.controllerHands.push(ray)
      ray.addEventListener('connected', e => { this.controllerSources[n] = e.data })
      ray.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: '#b3a4ff' })))
      ray.addEventListener('selectstart', () => {
        const r = new THREE.Raycaster(ray.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0, 0, -1).applyQuaternion(ray.getWorldQuaternion(new THREE.Quaternion())))
        if (r.intersectObject(this.exitTarget).length) void this.leave()
        else this.grabbing.add(n)
      })
      ray.addEventListener('selectend', () => { this.grabbing.delete(n) })
      ray.addEventListener('squeezestart', () => { this.grabbing.add(n) })
      ray.addEventListener('squeezeend', () => { this.grabbing.delete(n) })
      hand.addEventListener('pinchstart', () => { this.grabbing.add(n) })
      hand.addEventListener('pinchend', () => { this.grabbing.delete(n) })
      ray.addEventListener('disconnected', () => { this.grabbing.delete(n); this.controllerSources[n] = null })
    }
    renderer.xr.addEventListener('sessionend', () => { this.renderer.shadowMap.enabled = this.savedShadows; this.setMode('overview') })
    addEventListener('pagehide', () => { void this.leave() })
    // The hook uses the same rig and input path; it cannot create participants or replace host state.
    if (new URLSearchParams(location.search).get('test') === 'vr') Object.assign(window, { __presence: {
      experience: this, shared, enter: () => { this.emulated = true; this.setMode('xr') }, exit: () => this.leave(),
      state: () => ({ mode: this.mode, ride: this.ride, camera: pose(this.camera), fps: this.observedTime ? this.observedFrames / this.observedTime : 0, people: shared ? [...shared.people.values()] : [], bodies: shared?.world.bodies, status: shared?.status }),
    } })
  }
  get activeCamera() { return this.mode === 'overview' ? this.overview : this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera }
  get immersive() { return this.mode !== 'overview' }
  private save() { try { localStorage.setItem('obpal.comfort', JSON.stringify(this.settings)) } catch { /* private storage */ } }
  private showLink(url: string) { let a = this.controls.querySelector<HTMLAnchorElement>('a'); if (!a) { a = document.createElement('a'); this.controls.append(a) }; a.href = url; a.textContent = 'Open shared scene'; a.target = '_blank'; a.rel = 'noopener' }
  recenter() { this.yaw = this.pitch = 0; this.gyroZero = null; this.gyro.identity(); this.lastPosition = null }
  snap(direction: number) { this.yaw += direction * this.settings.snap * Math.PI / 180 }
  setMode(mode: ViewMode) {
    this.mode = mode; this.grab = false; this.grabbing.clear(); this.recenter()
    this.camera.position.set(0, 0, 0); this.camera.quaternion.identity()
    this.leaveButton.hidden = mode === 'overview'
    document.body.classList.toggle('presence-active', mode !== 'overview')
    if (mode === 'overview') this.controlsHome.prepend(this.controls)
    else document.body.append(this.controls)
    const soundControls = document.querySelector<HTMLElement>('.sim-sound')
    if (soundControls) {
      this.soundHome ??= soundControls.parentElement
      if (mode === 'overview') this.soundHome?.append(soundControls)
      else this.controls.append(soundControls)
    }
    if (this.orbit) this.orbit.enabled = mode === 'overview'
    if (mode === 'overview' && document.pointerLockElement === this.renderer.domElement) document.exitPointerLock()
    this.dispatchEvent(new Event('camerachange'))
    dispatchEvent(new CustomEvent('obpal:viewmode', { detail: mode }))
  }
  async enterXR() {
    if (this.xrPending || this.renderer.xr.isPresenting) return
    this.xrPending = true
    let session: XRSession | null = null
    try {
      session = await navigator.xr!.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking', 'dom-overlay'], domOverlay: { root: this.controls } })
      this.savedShadows = this.renderer.shadowMap.enabled
      await this.renderer.xr.setSession(session)
      this.setMode('xr')
      const rates = session.supportedFrameRates
      if (rates?.length && session.updateTargetFrameRate) { const hz = rates.includes(90) ? 90 : rates.includes(72) ? 72 : rates[0]; await session.updateTargetFrameRate(hz).catch(() => {}) }
    } catch { await session?.end().catch(() => {}); this.setMode('overview'); this.info.textContent = 'VR could not start. First person is available.' }
    finally { this.xrPending = false }
  }
  async leave() {
    this.emulated = false
    const session = this.renderer.xr.getSession()
    if (session) await session.end().catch(() => {})
    this.setMode('overview')
  }
  private async startSensors() {
    if (!matchMedia('(pointer: coarse)').matches) return
    const EventType = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> }
    try { if (EventType?.requestPermission && await EventType.requestPermission() !== 'granted') { this.info.textContent = 'Drag to look; motion permission was declined'; return }; this.sensor = true }
    catch { this.info.textContent = 'Drag to look; motion sensors are unavailable' }
  }
  private bindLook() {
    const canvas = this.renderer.domElement
    let held = false, x = 0, y = 0
    canvas.addEventListener('pointerdown', e => { if (this.mode !== 'first-person') return; held = true; x = e.clientX; y = e.clientY; canvas.setPointerCapture(e.pointerId) })
    canvas.addEventListener('pointerup', () => { held = false })
    canvas.addEventListener('pointercancel', () => { held = false })
    canvas.addEventListener('pointermove', e => {
      if (this.mode !== 'first-person' || (!held && document.pointerLockElement !== canvas)) return
      this.yaw -= (document.pointerLockElement === canvas ? e.movementX : e.clientX - x) * 0.004
      this.pitch = THREE.MathUtils.clamp(this.pitch - (document.pointerLockElement === canvas ? e.movementY : e.clientY - y) * 0.004, -1.45, 1.45)
      x = e.clientX; y = e.clientY
    })
    canvas.addEventListener('dblclick', () => { if (this.mode === 'first-person' && !matchMedia('(pointer: coarse)').matches) void canvas.requestPointerLock()?.catch(() => {}) })
    addEventListener('keydown', e => { if (!this.immersive || /INPUT|SELECT|TEXTAREA/.test((e.target as HTMLElement)?.tagName)) return; if (e.code === 'Escape') void this.leave(); if (e.code === 'KeyQ') this.snap(-1); if (e.code === 'KeyE') this.snap(1) })
    addEventListener('deviceorientation', e => {
      if (!this.sensor || this.mode !== 'first-person' || e.alpha === null || e.beta === null || e.gamma === null) return
      const d = Math.PI / 180
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(e.beta * d, e.alpha * d, -e.gamma * d, 'YXZ'))
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2))
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -(screen.orientation?.angle ?? 0) * d))
      this.gyroZero ??= q.clone().invert()
      this.gyro.copy(this.gyroZero).multiply(q)
    })
  }
  update(dt: number, now: number) {
    const rides = this.rides()
    if (!rides.some(r => r.id === this.ride)) this.ride = rides[0]?.id ?? ''
    if (now - this.lastUI > 500) {
      this.lastUI = now
      if ([...this.picker.options].map(o => o.value).join() !== rides.map(r => r.id).join()) this.picker.replaceChildren(...rides.map(r => new Option(r.name, r.id)))
      this.picker.value = this.ride
      this.info.textContent = this.shared?.status ?? (this.immersive ? 'Drag to look · Q / E turn · Escape returns' : '')
    }
    this.camera.aspect = this.renderer.domElement.clientWidth / Math.max(1, this.renderer.domElement.clientHeight); this.camera.updateProjectionMatrix()
    const r = rides.find(r => r.id === this.ride)
    if (r) {
      const p = r.pose(), e = new THREE.Euler().setFromQuaternion(p.q, 'YXZ')
      if (this.shared?.guest && this.lastPosition && this.lastPosition.distanceTo(p.p) < 3) p.p.lerp(this.lastPosition, Math.exp(-dt * 30))
      const speed = this.lastPosition && dt ? this.lastPosition.distanceTo(p.p) / dt : 0
      const turn = dt ? Math.atan2(Math.sin(e.y - this.lastYaw), Math.cos(e.y - this.lastYaw)) / dt : 0
      this.lastPosition = p.p.clone(); this.lastYaw = e.y
      if (this.settings.horizon && r.horizon) p.q.setFromAxisAngle(UP, e.y)
      this.rig.position.copy(p.p); this.rig.quaternion.copy(p.q).multiply(new THREE.Quaternion().setFromAxisAngle(UP, this.yaw))
      if (this.mode !== 'xr' || this.emulated) this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, 0, 0, 'YXZ')).multiply(this.gyro)
      const strength = this.immersive ? vignetteStrength(speed, turn, this.settings.vignette) : 0
      this.overlay.style.opacity = String(strength); this.mask.material.uniforms.strength.value = strength
    }
    const xr = this.renderer.xr.isPresenting
    this.rig.updateMatrixWorld(true)
    this.mask.visible = xr; this.exitTarget.visible = xr
    if (xr) {
      const hz = this.renderer.xr.getSession()?.frameRate ?? 72
      this.quality.frame(dt, hz); this.renderer.xr.setFoveation(this.quality.foveation)
      this.renderer.shadowMap.enabled = this.savedShadows && this.quality.shadows
      this.renderer.xr.updateCamera(this.camera)
      this.observedFrames++; this.observedTime += dt
    }
    if (this.shared && r) {
      const pad = emptyPad()
      const hands: Pose[] = []
      const order = [0, 1].sort((a, b) => Number(this.grabbing.has(b)) - Number(this.grabbing.has(a)))
      for (const n of order) {
        const source = this.controllerSources[n]
        if (!source) continue
        const gamepad = source.gamepad
        const controller = this.controllerHands[n]
        const wrist = this.renderer.xr.getHand(n).joints['wrist']
        const grip = this.renderer.xr.getControllerGrip(n)
        if (source.hand && wrist?.visible) hands.push(pose(wrist))
        else if (grip.visible) hands.push(pose(grip))
        else if (controller.visible) hands.push(pose(controller))
        else this.grabbing.delete(n)
        if (!gamepad || gamepad.mapping !== 'xr-standard') continue
        const side = source.handedness === 'left' ? 0 : 1
        pad.axes[side * 2] = gamepad.axes[2] ?? gamepad.axes[0] ?? 0; pad.axes[side * 2 + 1] = gamepad.axes[3] ?? gamepad.axes[1] ?? 0
        pad.triggers[side] = gamepad.buttons[0]?.value ?? 0
        if (gamepad.buttons[4]?.pressed) pad.buttons |= 1
        if (gamepad.buttons[5]?.pressed) void this.leave()
      }
      if (!this.drive) {
        if (Math.abs(pad.axes[2]) > 0.7 && !this.turning) this.snap(pad.axes[2] > 0 ? -1 : 1)
        this.turning = Math.abs(pad.axes[2]) > 0.3
      }
      const reference = this.renderer.xr.getReferenceSpace()
      const tracked = !xr || !!(reference && this.renderer.xr.getFrame()?.getViewerPose(reference))
      this.shared.input({ ride: this.ride, active: this.immersive && tracked, head: pose(xr ? this.renderer.xr.getCamera() : this.camera), hands, grab: this.grab || this.grabbing.size > 0, pad: this.drive && xr && tracked ? pad : null }, now)
      this.shared.tick(dt, now)
    }
  }
}
