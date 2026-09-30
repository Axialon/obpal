/** A single moving glass robot; the measured range arc follows its active joint. */
import * as THREE from 'three'
import { environment } from '../kit'
import { previewScene } from '../devices/view'
import { Rig } from './rig'
import { neutral, type RigProfile } from './profile'
import type { CalibrationStep } from './calibration'

export class RangeFigure {
  readonly el = document.createElement('div')
  private canvas = document.createElement('canvas')
  private arc = document.createElement('canvas')
  private renderer: THREE.WebGLRenderer | null = null
  private scene = previewScene()
  private camera = new THREE.PerspectiveCamera(27, 1, 0.05, 30)
  private rig: Rig | null = null
  private glass = new THREE.MeshPhysicalMaterial({ color: '#384c51', metalness: 0.45, roughness: 0.26, clearcoat: 0.6 })
  private active = new THREE.MeshPhysicalMaterial({
    color: '#c6ff34',
    emissive: '#c6ff34',
    emissiveIntensity: 0.1,
    metalness: 0.35,
    roughness: 0.22,
    clearcoat: 1,
  })
  private softGlass = new THREE.MeshStandardMaterial({ color: '#384c51', metalness: .15, roughness: .8 })
  private softActive = new THREE.MeshStandardMaterial({ color: '#c6ff34', emissive: '#c6ff34', emissiveIntensity: .1, roughness: .7 })

  constructor() {
    this.el.className = 'range-figure'
    this.el.setAttribute('role', 'img')
    this.el.setAttribute('aria-label', 'Demonstration and measured range')
    this.canvas.setAttribute('aria-hidden', 'true')
    this.arc.setAttribute('aria-hidden', 'true')
    this.el.append(this.canvas, this.arc)
    this.camera.position.set(1.8, 1.18, -4.6)
    this.camera.lookAt(0, 0.95, 0)
  }

  show(profile: RigProfile) {
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true })
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
      this.renderer.setClearColor(0, 0)
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping
      this.scene.environment = environment(this.renderer)
    }
    if (this.rig?.profile.id === profile.id) return
    this.hide()
    this.rig = new Rig(profile)
    this.rig.load()
    this.scene.add(this.rig.root)
  }
  hide() {
    this.rig?.dispose()
    this.rig = null
    this.renderer?.renderLists.dispose()
  }

  draw(now: number, step: CalibrationStep, progress: number, accent: string, reduced: boolean) {
    const { rig, renderer } = this
    if (!rig || !renderer) return
    const width = this.el.clientWidth,
      height = this.el.clientHeight
    if (!width || !height) return
    if (this.arc.width !== width || this.arc.height !== height) {
      this.arc.width = width
      this.arc.height = height
      renderer.setSize(width, height, false)
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
    }
    const channels = [...new Set(step.joints.map((id) => id.split('.').at(-1)!))]
    const channel = channels[reduced ? 0 : Math.floor(now / 4000) % channels.length]
    const active = step.joints.filter((id) => id.endsWith(channel))
    const q = neutral(rig.profile)
    const t = reduced ? 0.6 : (1 - Math.cos((now / 4000) * Math.PI * 2)) / 2
    for (const id of active) {
      const joint = rig.profile.joints.find((j) => j.id === id)!
      q[id] = joint.limits[0] + (joint.limits[1] - joint.limits[0]) * t
    }
    rig.pose(q)
    this.active.color.set(accent)
    this.active.emissive.set(accent)
    this.softActive.color.set(accent)
    this.softActive.emissive.set(accent)
    rig.root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      let node: THREE.Object3D | null = mesh.parent
      while (node && !node.userData.joint && !rig.pivots.has(node.name)) node = node.parent
      const id = node?.userData.joint ?? node?.name
      mesh.material = rig.profile.face
        ? (step.joints.includes(id) ? this.softActive : this.softGlass)
        : (step.joints.includes(id) ? this.active : this.glass)
    })
    renderer.render(this.scene, this.camera)
    const ctx = this.arc.getContext('2d')!
    ctx.clearRect(0, 0, width, height)
    if (!rig.root.visible) return
    const joint = rig.point(active[0] ?? step.joints[0]).project(this.camera)
    const x = ((joint.x + 1) * width) / 2,
      y = ((1 - joint.y) * height) / 2
    const radius = Math.min(32, width * 0.075),
      start = -Math.PI * 0.8,
      sweep = Math.PI * 1.6
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.strokeStyle = accent
    ctx.globalAlpha = 0.22
    ctx.beginPath()
    ctx.arc(x, y, radius, start, start + sweep)
    ctx.stroke()
    ctx.globalAlpha = 1
    if (progress) {
      ctx.beginPath()
      ctx.arc(x, y, radius, start, start + sweep * progress)
      ctx.stroke()
    }
  }
}
