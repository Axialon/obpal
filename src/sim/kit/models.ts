/**
 * Which Blender meshes a sim's page needs, and their download. Nothing here imports anything at run time (three.js and
 * its loaders come in with dynamic imports), so the small script every such page opens with (./early.ts) can start the
 * download before the rest of the page has arrived, and the page finds it under way.
 */
import type { Group, Mesh } from 'three'

export type Prototype = 'drone' | 'so101' | 'rover' | 'arm5' | 'six' | 'scara' | 'delta' | 'desk' | 'helicopter' | 'plane'
  | 'kart' | 'boat' | 'tank' | 'forklift' | 'excavator' | 'slotcars' | 'planetary' | 'submarine' | 'vacuum' | 'film-camera' | 'gimbal' | 'ptz' | 'dog' | 'studio'
  | 'keel' | 'morrow' | 'keel-lod' | 'morrow-lod' | 'humanoid-arena'
  | 'cairn-i' | 'cairn-ii' | 'rill-i' | 'rill-ii' | 'hush-i' | 'hush-ii'
  | 'cairn-i-lod' | 'cairn-ii-lod' | 'rill-i-lod' | 'rill-ii-lod' | 'hush-i-lod' | 'hush-ii-lod'

/** The mesh each robot arm kind wears (?kind=): its own id. The five-axis arm is the page's default. */
export const ARM_MODELS: readonly Prototype[] = ['arm5', 'so101', 'six', 'scara', 'delta', 'desk']
export const HUMANOID_MODELS: readonly Prototype[] = ['keel', 'morrow', 'humanoid-arena']

/** The meshes each device sim loads, by device id. A device that draws only procedurally has no row. */
export const DEVICE_MODELS: Readonly<Record<string, readonly Prototype[]>> = {
  rover: ['rover'], drone: ['drone'], boat: ['boat'], dog: ['dog'], excavator: ['excavator'], forklift: ['forklift'], gimbal: ['gimbal'],
  helicopter: ['helicopter'], kart: ['kart'], plane: ['plane'], planetary: ['planetary'], ptz: ['ptz'], slotcars: ['slotcars'], studio: ['studio'],
  submarine: ['submarine'], tank: ['tank'], vacuum: ['vacuum'], slider: ['film-camera'], jib: ['film-camera'],
}

export const prototypeUrl = (name: Prototype) => `/models/${name}.glb`

/** The meshes the page at this address will ask for: none for a page that draws only procedurally. */
export function pageModels(pathname: string, search: string): readonly Prototype[] {
  const params = new URLSearchParams(search)
  if (pathname.startsWith('/sim/humanoid/')) return HUMANOID_MODELS
  if (pathname.startsWith('/sim/arm')) {
    const kind = params.get('kind')
    return [ARM_MODELS.find(k => k === kind) ?? 'arm5']
  }
  // The device page reads its device from ?d=, or from the path a built page has (/sim/<id>/).
  const id = params.get('d') ?? pathname.split('/')[2] ?? ''
  return pathname.startsWith('/sim/') && Object.prototype.hasOwnProperty.call(DEVICE_MODELS, id) ? DEVICE_MODELS[id] : []
}

/** Where a download is: its bytes on the way, in and being decoded, or done (the scene, or nothing). */
export type DownloadStage = 'fetching' | 'decoding' | 'ready' | 'failed'
interface Download { started: number; stage: DownloadStage; scene: Promise<Group | null> }
const downloads = new Map<Prototype, Download>()

/** Humanoids release their shared geometry when their last active rig leaves. */
export function forgetPrototype(name: Prototype) {
  const download = downloads.get(name)
  downloads.delete(name)
  void download?.scene.then((scene) => {
    const geometries = new Set<import('three').BufferGeometry>()
    const materials = new Set<import('three').Material>()
    scene?.traverse((node) => {
      const mesh = node as Mesh
      if (!mesh.isMesh) return
      geometries.add(mesh.geometry)
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material)
    })
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) material.dispose()
  })
}

/**
 * Starts the mesh's download and its decoder at once, and only once: the mesh and the code that reads it arrive side by
 * side, not one after the other. Resolves to the decoded scene, or null when either fails (the procedural rig then
 * stays). Everyone gets the same scene: clone it (./prototype.ts does) before changing it.
 */
export function downloadPrototype(name: Prototype): Promise<Group | null> {
  let download = downloads.get(name)
  if (!download) {
    performance.mark(`obpal:${name}:load`)
    // Low priority: the page's scripts have the bandwidth first. The mesh is needed only once they have run, and the
    // network is idle while they do, which is when it comes.
    const bytes = fetch(prototypeUrl(name), { priority: 'low' }).then(async response => {
      if (!response.ok) throw new Error(`${response.status} for ${name}`)
      const buffer = await response.arrayBuffer()
      if (download) download.stage = 'decoding'
      return buffer
    })
    const loader = Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/libs/meshopt_decoder.module.js'),
    ]).then(async ([{ GLTFLoader }, { MeshoptDecoder }]) => {
      await MeshoptDecoder.ready
      return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    })
    const scene = Promise.all([bytes, loader]).then(async ([buffer, gltf]) => {
      const { scene } = await gltf.parseAsync(buffer, '')
      scene.traverse(o => {
        const m = o as Mesh
        if (!m.isMesh) return
        m.geometry.userData.simShared = true
        const materials = Array.isArray(m.material) ? m.material : [m.material]
        m.castShadow = materials.some(mat => ['ceramic', 'warmShell', 'carbon', 'darkTitanium', 'gunmetal'].includes(mat.name))
        m.receiveShadow = true
      })
      performance.mark(`obpal:${name}:decoded`)
      performance.measure(`obpal:${name}:load`, `obpal:${name}:load`, `obpal:${name}:decoded`)
      if (download) download.stage = 'ready'
      return scene
    }).catch(() => { if (download) download.stage = 'failed'; return null })
    download = { started: performance.now(), stage: 'fetching', scene }
    downloads.set(name, download)
  }
  return download.scene
}

/** When the mesh's download began (performance.now()), or null before it has. */
export const downloadStarted = (name: Prototype) => downloads.get(name)?.started ?? null

/** How far the mesh has got, or null before its download has begun. */
export const downloadStage = (name: Prototype): DownloadStage | null => downloads.get(name)?.stage ?? null
