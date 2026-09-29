/** A measured reference twin. Its pose never replaces either practice actor. */
import * as THREE from 'three'
import { environment } from '../kit'
import { previewScene } from '../devices/view'
import { Rig } from './rig'
import { KEEL, type Angles } from './profile'

export class DriverFigure {
  readonly el = document.createElement('div')
  private canvas = document.createElement('canvas')
  private renderer: THREE.WebGLRenderer | null = null
  private scene = previewScene()
  private camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20)
  private rig = new Rig(KEEL)
  private width = 0
  private height = 0
  constructor() {
    this.el.className = 'driver-figure'
    this.el.setAttribute('role', 'img')
    this.el.setAttribute('aria-label', 'Reference twin following reported joints')
    this.canvas.setAttribute('aria-hidden', 'true')
    this.el.append(this.canvas)
    this.scene.add(this.rig.root)
    this.camera.position.set(1.7, 1.25, -4.4)
    this.camera.lookAt(0, 0.94, 0)
  }
  draw(q: Angles) {
    if (!this.el.clientWidth || !this.el.clientHeight) return
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true })
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
      this.renderer.setClearColor(0, 0)
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping
      this.scene.environment = environment(this.renderer)
      this.rig.load()
    }
    const width = this.el.clientWidth,
      height = this.el.clientHeight
    if (this.width !== width || this.height !== height) {
      this.width = width
      this.height = height
      this.renderer.setSize(width, height, false)
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
    }
    this.rig.pose(q)
    this.renderer.render(this.scene, this.camera)
  }
  close() {
    this.renderer?.dispose()
    this.renderer = null
    this.width = this.height = 0
  }
}
