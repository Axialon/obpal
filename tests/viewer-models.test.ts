import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { CATALOG } from '../src/viewer/catalog'
import { glbJson } from '../src/viewer/local-scan'
import { disposeModel } from '../src/viewer/model-resources'
import { readViewerModel } from './viewer-model-node.mjs'
import allowedParts from './fixtures/viewer-model-parts.json'

interface Node { name?: string; mesh?: number; children?: number[]; camera?: number; skin?: number; extensions?: unknown }
interface Document {
  scenes: { nodes: number[] }[]
  nodes: Node[]
  meshes: { primitives: { mode?: number }[] }[]
  cameras?: unknown[]
  extensionsUsed?: string[]
  extensions?: Record<string, unknown>
}

describe('viewer catalogue assets', () => {
  const models = CATALOG.filter((item) => item.src)
  it('has an explicit parts contract for every catalogue GLB', () => {
    expect(models.map((item) => item.src).sort()).toEqual(Object.keys(allowedParts).sort())
  })
  it.each(models)('$id exports only its approved meshes and structural anchors', (item) => {
    const doc: Document = JSON.parse(glbJson(readViewerModel(item.src!))!)
    const allowed = allowedParts[item.src! as keyof typeof allowedParts]
    expect(doc.cameras ?? []).toHaveLength(0)
    expect(doc.extensions?.KHR_lights_punctual).toBeUndefined()
    for (const node of doc.nodes) {
      expect(node.camera).toBeUndefined()
      expect(node.skin).toBeUndefined()
      expect(node.extensions).toBeUndefined()
    }
    // The inventory explicitly allows authored pivot/label anchors and unnamed legacy mesh parts.
    expect(doc.nodes.map((node) => [node.name ?? '', node.mesh ?? null, node.children ?? []])).toEqual(allowed.nodes)
    expect(doc.meshes.map((mesh) => mesh.primitives.map((part) => part.mode ?? 4))).toEqual(allowed.primitives)
    expect(doc.extensionsUsed ?? []).toEqual(allowed.extensions)
    expect(doc.scenes.map((scene) => scene.nodes)).toEqual(allowed.scenes)
    expect(doc.scenes).toHaveLength(1)
    expect(doc.scenes[0].nodes).toHaveLength(1)
    const visited = new Set<number>()
    const walk = (index: number) => {
      expect(visited.has(index), `duplicate or cyclic node ${index}`).toBe(false)
      visited.add(index)
      for (const child of doc.nodes[index].children ?? []) walk(child)
    }
    doc.scenes[0].nodes.forEach(walk)
    expect(visited.size).toBe(doc.nodes.length)
    expect(new Set(doc.nodes.flatMap((node) => node.mesh === undefined ? [] : [node.mesh])).size).toBe(doc.meshes.length)
  })
})

describe('viewer model resources', () => {
  it('disposes shared geometry, materials, texture maps and shader textures once per model', () => {
    const root = new THREE.Group()
    const geometry = new THREE.BoxGeometry()
    const texture = new THREE.Texture()
    const shaderTexture = new THREE.Texture()
    const material = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture })
    const shader = new THREE.ShaderMaterial({ uniforms: { maps: { value: [texture, shaderTexture] } } })
    root.add(new THREE.Mesh(geometry, [material, shader]), new THREE.Mesh(geometry, material))
    const spies = [geometry, texture, shaderTexture, material, shader].map((resource) => vi.spyOn(resource, 'dispose'))
    disposeModel(root)
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1)
  })
})
