/** Procedural parts shared by the sim family. Dimensions are metres; y is up. */
import * as THREE from 'three'
import { DETAIL, HOUSING, plateGeometry } from './precision'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { preserveContact } from '../contact'

export const palette = { carbon: '#252b32', trim: '#11171d', metal: '#abb7c1', lime: '#c6ff34', porcelain: '#e5e9e5' }
const plastics = new Map<string, THREE.MeshPhysicalMaterial>()
/** Shared moulded plastic. Animated lights deliberately have their own materials. */
export function plastic(color = palette.porcelain) {
  let m = plastics.get(color)
  if (!m) { m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.4, metalness: 0.08, clearcoat: 0.22, clearcoatRoughness: 0.35 }); m.userData.simShared = true; plastics.set(color, m) }
  return m
}
export const metal = new THREE.MeshStandardMaterial({ color: palette.metal, metalness: 0.88, roughness: 0.34 })
export const rubber = new THREE.MeshStandardMaterial({ color: '#15191b', roughness: 0.94, metalness: 0 })
export const glass = new THREE.MeshPhysicalMaterial({ color: '#7896aa', roughness: 0.09, metalness: 0.15, clearcoat: 1, transparent: true, opacity: 0.32, depthWrite: false })
for (const material of [metal, rubber, glass]) material.userData.simShared = true

/** Retained API for existing envelopes, now using the two physical chamfer sizes. */
const roundedParts = new Map<string, THREE.BufferGeometry>()
export function rounded(w: number, h: number, d: number, r = Math.min(w, h, d) * 0.18) {
  const key = [w, h, d, r].join(':')
  let geometry = roundedParts.get(key)
  if (!geometry) { geometry = plateGeometry(w, h, d, Math.min(w, h, d) < .02 ? DETAIL : HOUSING); geometry.userData.simShared = true; roundedParts.set(key, geometry) }
  return geometry
}
export function box(w: number, h: number, d: number, m: THREE.Material, r?: number) {
  const mesh = new THREE.Mesh(rounded(w, h, d, r), m)
  mesh.receiveShadow = true
  return mesh
}
export function cylinder(r: number, h: number, m: THREE.Material = metal, segments = 20) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, segments), m)
  mesh.receiveShadow = true
  return mesh
}
/** A cable or rail between arbitrary points. */
export function cable(points: readonly (readonly [number, number, number])[], radius = 0.008, material: THREE.Material = rubber) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)))
  return new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, points.length * 5), radius, 6, false), material)
}
/** A recessed hex socket, facing up; callers turn the whole part to another face. */
export function bolt(radius = 0.009) {
  const g = new THREE.Group()
  g.userData.static = true
  const head = cylinder(radius, radius * 0.4, metal, 12)
  const socket = cylinder(radius * 0.48, radius * 0.42, rubber, 6)
  socket.position.y = radius * 0.06
  g.add(head, socket)
  return g
}
/** A geometric maker mark: two inset bars and the family dot, with no external assets. */
export function maker(parent: THREE.Object3D, x: number, y: number, z: number, size = 0.06) {
  const mark = new THREE.Group()
  mark.userData.static = true
  mark.position.set(x, y, z)
  const m = metal
  for (let i = 0; i < 2; i++) { const b = box(size * 0.2, size * 0.08, size * (i ? 0.6 : 1), m); b.position.x = (i - 0.5) * size * 0.32; mark.add(b) }
  parent.add(mark)
  return mark
}

/** Merge static details within each rigid group, preserving every animated object passed in keep. */
export function batch(root: THREE.Object3D, keep: readonly THREE.Object3D[] = [], mergeTransparent = false) {
  const protectedObjects = new Set(keep)
  const visit = (group: THREE.Object3D) => {
    for (const child of [...group.children]) if (!protectedObjects.has(child)) visit(child)
    for (const child of [...group.children]) if (child.userData.static && !protectedObjects.has(child)) {
      child.updateMatrix()
      preserveContact(child, group)
      for (const part of [...child.children]) { part.applyMatrix4(child.matrix); group.add(part) }
      group.remove(child)
    }
    const byMat = new Map<THREE.Material, THREE.Mesh[]>()
    for (const child of group.children) {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || protectedObjects.has(mesh) || mesh.children.length || Array.isArray(mesh.material) || (mesh.material.transparent && !mergeTransparent)) continue
      const list = byMat.get(mesh.material) ?? []; list.push(mesh); byMat.set(mesh.material, list)
    }
    for (const [material, meshes] of byMat) {
      if (meshes.length < 2) continue
      const geometries = meshes.map(m => { m.updateMatrix(); const g = m.geometry.clone().applyMatrix4(m.matrix); return g.index ? g.toNonIndexed() : g })
      // Authored metal skins omit texture coordinates. The kit's primitives include
      // them even for solid finishes; pad that unused stream before joining both.
      if (geometries.some(g => g.hasAttribute('uv'))) for (const g of geometries) {
        if (!g.hasAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
      }
      const geometry = mergeGeometries(geometries)
      geometries.forEach(g => g.dispose())
      if (!geometry) continue
      const merged = new THREE.Mesh(geometry, material)
      merged.castShadow = meshes.some(m => m.castShadow)
      merged.receiveShadow = meshes.some(m => m.receiveShadow)
      meshes.forEach(m => { preserveContact(m, group); group.remove(m) })
      group.add(merged)
    }
  }
  // Flatten nonanimated detail groups before batching, but never cross a moving pivot.
  visit(root)
}

/** Clean satin surfaces carry reflections without procedural grain or noise. */
export function floorMaterial(color = '#30373d') {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.36, metalness: 0.68 })
}

/** One PMREM per renderer, with temporary generator resources released immediately. */
export function environment(renderer: THREE.WebGLRenderer) {
  const generator = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  const map = generator.fromScene(room, 0.04)
  room.dispose(); generator.dispose()
  return map.texture
}

export function softKey(scene: THREE.Scene, radius: number) {
  const key = new THREE.DirectionalLight('#fff3e3', 2.3)
  key.position.set(-radius * 0.6, radius * 1.6, radius)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  Object.assign(key.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: 0.1, far: radius * 5 })
  key.shadow.normalBias = 0.015; key.shadow.bias = -0.0002; key.shadow.radius = 3
  scene.add(key)
  return key
}
