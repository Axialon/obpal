import * as THREE from 'three'
import { batch, floorMaterial, maker, metal, plastic, rounded, rubber } from '../kit'
import { block, disc, playFrame, rod, showcase } from './parts'
import { SORTING, SortingLogic } from './sorting'
import type { Stage } from './stage'
import { restInput } from './types'
import { mats, wear, type DeviceView } from './view'

function cell(n: number) {
  const root = new THREE.Group(), frame = new THREE.Group(), pusher = new THREE.Group(), bins = new THREE.Group()
  root.name = `sorting-cell-${n + 1}`
  frame.name = 'conveyor-frame'
  pusher.name = 'pusher-carriage'
  bins.name = 'colour-bins'
  root.position.x = SORTING.centres[n]
  root.add(frame, pusher, bins)
  const trim = plastic('#344149'), glow = mats.glow()
  for (const x of [-0.55, 0.55]) {
    block(frame, [0.09, 0.18, 3], [x, 0.76, -0.95], metal)
    for (const z of [-2.2, 0.3]) {
      block(frame, [0.1, 0.7, 0.1], [x, 0.35, z], metal)
      block(frame, [0.23, 0.05, 0.23], [x, 0.025, z], rubber)
    }
  }
  block(frame, [1.05, 0.15, 2.9], [0, 0.74, -0.95], rubber)
  block(frame, [3.1, 0.12, 0.55], [0, 0.76, 0.35], metal)
  for (const z of [0.1, 0.55]) rod(frame, [-1.45, 0.88, z], [1.45, 0.88, z], 0.022)
  const motor = disc(frame, 0.16, 0.28, [0.7, 0.69, -2.2], trim)
  motor.rotation.z = Math.PI / 2
  block(frame, [0.36, 0.32, 0.28], [-0.82, 0.94, -0.45], trim)
  block(frame, [0.24, 0.03, 0.16], [-0.82, 1.115, -0.45], glow)
  maker(frame, -0.82, 1.14, -0.45, 0.11)
  for (let k = 0; k < 3; k++) {
    const bin = new THREE.Group()
    bin.name = `${SORTING.names[k].toLowerCase()}-bin`
    bin.position.set(SORTING.lanes[k], 0, SORTING.bin)
    bins.add(bin)
    const colour = plastic(SORTING.colours[k])
    block(bin, [0.82, 0.08, 0.88], [0, 0.15, 0], colour)
    for (const x of [-0.39, 0.39]) block(bin, [0.055, 0.48, 0.88], [x, 0.39, 0], colour)
    block(bin, [0.82, 0.48, 0.055], [0, 0.39, 0.415], colour)
    block(bin, [0.82, 0.28, 0.055], [0, 0.29, -0.415], colour)
    const chute = block(bin, [0.73, 0.045, 0.78], [0, 0.7, -0.54], metal)
    chute.rotation.x = 0.26
    batch(bin)
  }
  block(pusher, [0.54, 0.055, 0.52], [0, 0.88, 0.25], trim)
  const ram = new THREE.Group()
  ram.name = 'pusher-ram'
  pusher.add(ram)
  block(ram, [0.45, 0.3, 0.06], [0, 1.04, -0.12], plastic('#e5e9e5'))
  rod(ram, [0, 0.98, -0.6], [0, 0.98, -0.14], 0.035, metal)
  batch(ram)
  batch(pusher, [ram])
  batch(frame)
  const slats = new THREE.InstancedMesh(rounded(0.96, 0.035, 0.16), trim, 12)
  slats.name = 'belt-slats'
  slats.castShadow = true
  root.add(slats)
  const parts = Array.from({ length: 5 }, () => {
    const part = block(root, [0.33, 0.24, 0.3], [0, 0.98, 0], plastic(SORTING.colours[0]))
    part.name = 'conveyor-part'
    return part
  })
  const carried = block(root, [0.33, 0.24, 0.3], [0, 1.02, 0], plastic(SORTING.colours[0]))
  carried.name = 'sorted-part'
  const marker = block(root, [0.6, 0.02, 0.13], [0, 0.96, 0.64], plastic('#c6ff34'))
  marker.name = 'lane-selection'
  const piles = SORTING.lanes.map((x, k) => {
    const pile = new THREE.InstancedMesh(rounded(0.25, 0.16, 0.23), plastic(SORTING.colours[k]), 6)
    pile.name = `${SORTING.names[k].toLowerCase()}-sorted-parts`
    pile.position.set(x, 0, SORTING.bin)
    root.add(pile)
    return pile
  })
  return { root, pusher, ram, slats, parts, carried, marker, piles, glow }
}

function workshop(scene: THREE.Scene, logic: SortingLogic) {
  const floor = new THREE.Group()
  floor.name = 'workshop-floor'
  block(floor, [8.7, 0.1, 6.4], [0, -0.07, -0.2], floorMaterial('#485456'))
  scene.add(floor)
  const cells = logic.units.map((_, n) => { const model = cell(n); scene.add(model.root); return model }),
    transform = new THREE.Object3D()
  return {
    step(colors: readonly (string | null)[] = []) {
      cells.forEach((m, n) => {
        const u = logic.units[n]
        wear(m.glow, colors[n] ?? null)
        m.pusher.position.x = u.x
        m.ram.position.z = u.push * (SORTING.bin - SORTING.ready)
        m.marker.position.x = SORTING.lanes[u.lane]
        m.parts.forEach((mesh, k) => {
          const part = u.parts[k]
          mesh.visible = !!part
          if (!part) return
          mesh.position.z = part.z
          mesh.material = plastic(SORTING.colours[part.colour])
        })
        m.carried.visible = u.held !== null
        if (u.held !== null) {
          m.carried.material = plastic(SORTING.colours[u.held])
          m.carried.position.set(u.x, 1 - u.push * 0.42, SORTING.ready + u.push * (SORTING.bin - SORTING.ready))
        }
        for (let k = 0; k < 12; k++) {
          transform.position.set(0, 0.83, -2.3 + k * 0.24 + u.belt)
          transform.updateMatrix()
          m.slats.setMatrixAt(k, transform.matrix)
        }
        m.slats.instanceMatrix.needsUpdate = true
        m.piles.forEach((pile, k) => {
          pile.count = Math.min(6, u.bins[k])
          for (let j = 0; j < pile.count; j++) {
            transform.position.set(j % 2 ? 0.17 : -0.17, 0.29 + Math.floor(j / 2) * 0.16, 0)
            transform.updateMatrix()
            pile.setMatrixAt(j, transform.matrix)
          }
          pile.instanceMatrix.needsUpdate = true
        })
      })
    },
  }
}

export function createView(stage: Stage, logic: SortingLogic): DeviceView {
  const world = workshop(stage.scene, logic),
    at = (n: number): [number, number, number] => [SORTING.centres[n], 0.65, -0.3]
  world.step()
  let previous = ''
  return {
    framing: playFrame(at(0), 1.65),
    overview: playFrame([0, 0.6, -0.25], 3.5),
    inspect: () => playFrame([SORTING.centres[0], 0.8, 0.55], 1.1),
    follow: (n) => new THREE.Vector3(...at(n)),
    pickY: 0.9,
    pointFrom: (n) => new THREE.Vector3(SORTING.centres[n], 0.9, 0.8),
    update(colors) {
      const state = JSON.stringify([logic.units, colors])
      if (state !== previous) { world.step(colors); previous = state }
    },
  }
}

export function preview() {
  const logic = new SortingLogic(), input = restInput('face.wii')
  return showcase((scene) => {
    const world = workshop(scene, logic)
    return { step(_t, dt) {
      const u = logic.units[0]
      const lane = u.parts[0]?.colour ?? 1
      input.point = { x: 0, y: 0, yaw: 0, pitch: 0, off: false }
      input.spot = [SORTING.centres[0] + SORTING.lanes[lane], 0.8]
      input.presses = u.phase === 'ready' && u.parts[0]?.z >= SORTING.ready - 0.02 ? ['sort'] : []
      logic.step([input], dt)
      logic.drain()
      world.step()
    } }
  }, [SORTING.centres[0], 0.7, -0.3], 1.65)
}
