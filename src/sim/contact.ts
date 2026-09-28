/** Geometry contact diagnostics. World units are metres unless a part declares a different scale. */
import * as THREE from 'three'
import { boxPenetration, geometryBox, type ContactBox } from './contact-box'

export type ContactMode = 'touch' | 'clear' | 'free'
export interface ContactOptions {
  /** Airborne parts need clearance; a falling marble in a hole is free. */
  mode?: ContactMode | (() => ContactMode)
  surface?: string | (() => string)
  /** A supported part may itself support another part. */
  supports?: string
  /** Examine the lower hull on a slope; the world-lowest vertex need not be the contact vertex. */
  slope?: boolean
  /** A boat's keel has a deliberate negative gap equal to its draft. */
  expectedGap?: number
  obstacle?: string
  collides?: string
  /** Exact narrow-phase depth for contacts which are not boxes, in world metres. */
  penetration?: () => number
  active?: () => boolean
  metresPerUnit?: number
}
interface Shape { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4; cast: boolean; receive: boolean }
interface Binding { name: string; surface: boolean; options: ContactOptions; shapes?: Shape[]; instance?: { mesh: THREE.InstancedMesh; index: number } }
const bindings = new WeakMap<THREE.Object3D, Binding>()

/** Mark actual rendered geometry, without adding a draw or changing the simulation. */
export function contactPart<T extends THREE.Object3D>(part: T, name: string, options: ContactOptions = {}): T {
  bindings.set(part, { name, surface: false, options })
  return part
}
export function contactSurface<T extends THREE.Object3D>(part: T, name = 'ground'): T {
  bindings.set(part, { name, surface: true, options: {} })
  return part
}
export function contactObstacle<T extends THREE.Object3D>(part: T, name = 'wall'): T {
  bindings.set(part, { name, surface: false, options: { obstacle: name } })
  return part
}

/** Measure only rigid meshes at this frame, excluding its moving child joints. */
export function contactFrame(frame: THREE.Object3D, name: string) {
  frame.getObjectByName(`contact:${name}`)?.removeFromParent()
  const anchor = new THREE.Object3D(), shapes: Shape[] = []
  for (const child of frame.children) if ((child as THREE.Mesh).isMesh || child.name.startsWith(`${frame.name}_`)) {
    child.updateMatrix()
    for (const shape of shapesOf(child)) shapes.push({ ...shape, matrix: child.matrix.clone().multiply(shape.matrix) })
  }
  anchor.name = `contact:${name}`; frame.add(anchor)
  bindings.set(anchor, { name, surface: false, options: {}, shapes })
}

/** Bind the allocated capacity, including instances activated later by increasing count. */
export function contactInstances(mesh: THREE.InstancedMesh, name: string, options: (i: number) => ContactOptions = () => ({})) {
  for (let index = 0; index < mesh.instanceMatrix.count; index++) {
    const anchor = new THREE.Object3D(); mesh.add(anchor)
    bindings.set(anchor, { name: `${name}-${index + 1}`, surface: false, options: options(index), instance: { mesh, index } })
  }
}

function shapesOf(root: THREE.Object3D): Shape[] {
  const shapes: Shape[] = []
  const visit = (part: THREE.Object3D, matrix: THREE.Matrix4) => {
    const mesh = part as THREE.Mesh
    if (mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) {
      shapes.push({ geometry: mesh.geometry, matrix, cast: mesh.castShadow, receive: mesh.receiveShadow })
    }
    for (const child of part.children) {
      child.updateMatrix()
      visit(child, matrix.clone().multiply(child.matrix))
    }
  }
  visit(root, new THREE.Matrix4())
  return shapes
}

/** Keep a measurement anchor when batching removes a mesh or flattens a rigid group. No extra rendering. */
export function preserveContact(part: THREE.Object3D, parent: THREE.Object3D) {
  const binding = bindings.get(part)
  if (!binding) return
  const anchor = new THREE.Object3D()
  anchor.name = `contact:${binding.name}`
  anchor.position.copy(part.position); anchor.quaternion.copy(part.quaternion); anchor.scale.copy(part.scale)
  bindings.set(anchor, { ...binding, shapes: binding.shapes ?? shapesOf(part) })
  bindings.delete(part)
  parent.add(anchor)
}

/** Exact vertex minimum, including nonuniform scale and every parent transform; never a rotated world AABB. */
export function lowestPoint(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.Vector3 {
  const p = new THREE.Vector3(), sum = new THREE.Vector3()
  const positions = geometry.getAttribute('position')
  if (!positions) return p.set(NaN, Infinity, NaN)
  let low = Infinity, count = 0
  for (let i = 0; i < positions.count; i++) {
    p.fromBufferAttribute(positions, i).applyMatrix4(matrix)
    if (p.y < low - 1e-7) { low = p.y; sum.copy(p); count = 1 }
    else if (Math.abs(p.y - low) <= 1e-7) { sum.add(p); count++ }
  }
  return count ? sum.divideScalar(count) : p.set(NaN, NaN, NaN)
}

export interface ContactReading {
  part: string
  surface: string | null
  mode: ContactMode
  point: [number, number, number]
  lowest: [number, number, number]
  lowestGapMm: number | null
  gap: number | null
  gapMm: number | null
  expectedGap: number
  castsShadow: boolean
  receivesShadow: boolean
  penetrationMm: number
}

/** Test-only sampling is opt-in. Calling sample every animation frame also captures an asynchronous skin swap. */
export function contactProbe(scene: THREE.Object3D) {
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0)
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  return {
    sample(): ContactReading[] {
      scene.updateWorldMatrix(true, true)
      const parts: { object: THREE.Object3D; binding: Binding }[] = []
      const obstacles: { object: THREE.Object3D; name: string; box: ContactBox }[] = []
      const surfaces: { name: string; mesh: THREE.Mesh; receive: boolean; owner: THREE.Object3D }[] = []
      scene.traverse(object => {
        const binding = bindings.get(object)
        if (!binding || binding.options.active?.() === false || binding.instance && binding.instance.index >= binding.instance.mesh.count) return
        // Instance sources can be invisible while their rendered copies remain visible.
        if (binding.options.obstacle) for (const shape of binding.shapes ?? shapesOf(object)) {
          if (shape.geometry.getAttribute('position')) obstacles.push({ object, name: binding.options.obstacle, box: geometryBox(shape.geometry, object.matrixWorld.clone().multiply(shape.matrix)) })
        }
        if (!binding.surface && !(binding.options.obstacle && !binding.options.collides && !binding.options.supports)) parts.push({ object, binding })
        if (!binding.surface && !binding.options.supports) return
        let shapes = binding.shapes ?? shapesOf(object)
        if (binding.instance) {
          const { mesh, index } = binding.instance, matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix)
          shapes = [{ geometry: mesh.geometry, matrix, cast: mesh.castShadow, receive: mesh.receiveShadow }]
        }
        for (const shape of shapes) {
          const mesh = new THREE.Mesh(shape.geometry, material)
          mesh.matrixAutoUpdate = false
          mesh.matrixWorld.multiplyMatrices(object.matrixWorld, shape.matrix)
          surfaces.push({ name: binding.options.supports ?? binding.name, mesh, receive: shape.receive, owner: object })
        }
      })
      return parts.map(({ object, binding }) => {
        let inherited: ContactMode = 'touch', prefix = ''
        for (let parent = object.parent; parent && parent !== scene; parent = parent.parent) {
          if (parent.userData.contactMode) inherited = parent.userData.contactMode as ContactMode
          const name = parent.userData.contactName ?? parent.name
          if (name && !name.startsWith('contact:')) prefix = `${name}/${prefix}`
        }
        const mode = typeof binding.options.mode === 'function' ? binding.options.mode() : binding.options.mode ?? inherited
        let point = new THREE.Vector3(0, Infinity, 0), top = -Infinity, castsShadow = false
        let shapes = binding.shapes ?? shapesOf(object)
        if (binding.instance) {
          const { mesh, index } = binding.instance, matrix = new THREE.Matrix4()
          mesh.getMatrixAt(index, matrix)
          shapes = [{ geometry: mesh.geometry, matrix, cast: mesh.castShadow, receive: mesh.receiveShadow }]
        }
        for (const shape of shapes) {
          const low = lowestPoint(shape.geometry, new THREE.Matrix4().multiplyMatrices(object.matrixWorld, shape.matrix))
          if (low.y < point.y) point = low
          if (shape.geometry.getAttribute('position')) {
            if (!shape.geometry.boundingBox) shape.geometry.computeBoundingBox()
            top = Math.max(top, shape.geometry.boundingBox!.clone().applyMatrix4(object.matrixWorld.clone().multiply(shape.matrix)).max.y)
          }
          castsShadow ||= shape.cast
        }
        const target = typeof binding.options.surface === 'function' ? binding.options.surface() : binding.options.surface ?? 'ground'
        const candidates = surfaces.filter(s => s.name === target && s.owner !== object)
        const meshes = candidates.map(s => s.mesh)
        const supportHit = (p: THREE.Vector3) => {
          ray.set(new THREE.Vector3(p.x, Math.max(top, p.y) + 100, p.z), down)
          // Only upward-facing support faces count. A shelf wholly above the part is overhead,
          // not penetration; if everything is above it, the nearest face reveals a fully sunk part.
          const hits = ray.intersectObjects(meshes, false).filter(h => h.face && h.face.normal.clone().transformDirection(h.object.matrixWorld).y > 1e-6)
          return hits.find(h => h.point.y <= top + 1e-6) ?? hits.at(-1)
        }
        let hit = supportHit(point)
        const lowest = point.clone(), lowestGapMm = hit ? (point.y - hit.point.y) * 1000 : null
        // A broad foot can bridge a grout seam beneath its averaged lowest point.
        // Resolve the actual lower hull before calling that a floating part.
        if (binding.options.slope || mode === 'touch' && hit && point.y - hit.point.y > 1e-7) {
          const points: THREE.Vector3[] = []
          const unique = new Set<string>()
          for (const shape of shapes) {
            const positions = shape.geometry.getAttribute('position'), matrix = object.matrixWorld.clone().multiply(shape.matrix)
            if (positions) for (let i = 0; i < positions.count; i++) {
              const p = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(matrix), key = p.toArray().map(v => v.toFixed(6)).join(':')
              if (!unique.has(key)) { unique.add(key); points.push(p) }
            }
          }
          const bottom = Math.min(...points.map(p => p.y))
          for (const p of points) {
            if (p.y > bottom + (top - bottom) * .2) continue
            const h = supportHit(p)
            if (h && (!hit || p.y - h.point.y < point.y - hit.point.y)) { point = p; hit = h }
          }
        }
        const surface = hit ? candidates.find(s => s.mesh === hit.object)! : null
        const gap = hit ? point.y - hit.point.y : null
        let penetrationMm = (binding.options.penetration?.() ?? 0) * 1000
        if (binding.options.collides) for (const shape of shapes) {
          if (!shape.geometry.getAttribute('position')) continue
          const box = geometryBox(shape.geometry, object.matrixWorld.clone().multiply(shape.matrix))
          for (const obstacle of obstacles) if (obstacle.name === binding.options.collides && obstacle.object !== object) penetrationMm = Math.max(penetrationMm, boxPenetration(box, obstacle.box) * 1000)
        }
        return { part: prefix + binding.name, surface: surface?.name ?? null, mode, point: point.toArray() as [number, number, number], lowest: lowest.toArray() as [number, number, number], lowestGapMm,
          gap, expectedGap: binding.options.expectedGap ?? 0,
          gapMm: gap === null ? null : (gap - (binding.options.expectedGap ?? 0)) * 1000 * (binding.options.metresPerUnit ?? 1), castsShadow, receivesShadow: surface?.receive ?? false, penetrationMm }
      })
    },
    dispose() { material.dispose() },
  }
}

/** The browser harness reads geometry and records frames; it never steers the physics. */
export function contactRecorder(scene: THREE.Scene, camera: THREE.Camera) {
  const probe = contactProbe(scene)
  let recording = false, frames: ContactReading[][] = []
  const api = {
    scene, camera, sample: probe.sample,
    count: () => frames.length,
    start() { frames = []; recording = true },
    stop() { recording = false; return frames },
  }
  Object.assign(window, { __contacts: api })
  return () => { if (recording && frames.length < 1200) frames.push(probe.sample()) }
}
