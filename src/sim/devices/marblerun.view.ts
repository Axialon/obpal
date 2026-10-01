import { contactPart, contactSurface } from '../contact'
import * as THREE from 'three'
import { darkTitanium, gunmetal, carbon } from '../kit/surfaces'
import { pov, tiledDeck } from '../kit/precision'
import { batch, metal, plastic } from '../kit'
import { MarblerunLogic, RUN, trackEnds } from './marblerun'
import { CUP, cupSurface } from '../physics/marblerun'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'

function boards(scene: THREE.Scene, logic: MarblerunLogic, count = 2) {
  const channelPose = new THREE.Matrix4()
  const glass = new THREE.MeshPhysicalMaterial({ color: '#a9d9dc', metalness: 0, roughness: 0.13, transmission: 0.75, thickness: 0.04, ior: 1.5, clearcoat: 1 })
  const sphereGlass = glass.clone(); sphereGlass.color.set('#87c6dc'); sphereGlass.thickness = 0.11
  const models = logic.units.slice(0, count).map((u, n) => {
    const base = new THREE.Group(); base.name = `track-pedestal-${n + 1}`; base.position.x = n * 3.8; scene.add(base)
    base.add(tiledDeck(3.3, 3.3, 0, 1.1))
    contactPart(disc(base, 0.7, 0.18, [0, 0.09, 0], darkTitanium), 'pedestal'); rod(base, [0, 0.1, 0], [0, 0.8, 0], 0.15, metal); batch(base)
    const board = new THREE.Group(); board.name = 'tilting-build-board'; board.position.y = 0.9; base.add(board)
    pov(board, [0, .6, 1.48], [0, -.4, -1])
    contactSurface(block(board, [3.05, 0.12, 3.05], [0, -0.06, 0], gunmetal), `board-${n}`)
    const light = mats.glow(); block(board, [0.45, 0.01, 0.08], [0, 0, 1.48], light)
    for (let k = 0; k <= 5; k++) {
      const at = (k - 2.5) * RUN.cell
      block(board, [0.008, 0.003, 2.9], [at, 0, 0], carbon); block(board, [2.9, 0.003, 0.008], [0, 0, at], carbon)
    }
    batch(board)
    const pieces = Array.from({ length: 25 }, (_, j) => {
      const g = new THREE.Group(); g.name = `channel-${j + 1}`; g.position.set((j % 5 - 2) * RUN.cell, -0.0125, (Math.floor(j / 5) - 2) * RUN.cell); board.add(g)
      const kinds = [0, 1].map(kind => {
        const shape = new THREE.Group(); shape.name = kind ? 'bend' : 'straight'; g.add(shape)
        block(shape, [0.36, 0.025, 0.36], [0, 0, 0], glass)
        for (const d of trackEnds({ kind, turn: 0 })) {
          const arm = new THREE.Group(); arm.rotation.y = -d * Math.PI / 2; arm.userData.static = true; shape.add(arm)
          block(arm, [0.29, 0.024, 0.36], [0.145, 0, 0], glass)
          for (const z of [-0.18, 0.18]) block(arm, [0.29, 0.085, 0.025], [0.145, 0.025, z], glass)
        }
        batch(shape); return shape
      })
      return { g, kinds }
    })
    // Channel geometry repeats across the board; only its placement and turn vary.
    const channels = [0, 1].flatMap(kind => pieces[0].kinds[kind].children.map((child, index) => {
      const source = child as THREE.Mesh
      const mesh = new THREE.InstancedMesh(source.geometry, source.material, pieces.length)
      mesh.name = `channel-instances-${kind}-${index}`; mesh.castShadow = mesh.receiveShadow = true
      mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); board.add(mesh)
      for (const piece of pieces) piece.kinds[kind].children[index].visible = false
      return { mesh, kind, index }
    }))
    const cursor = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.25, 32), plastic('#e6b766')); cursor.name = 'build-cursor'; cursor.rotation.x = -Math.PI / 2; board.add(cursor)
    const profile = Array.from({ length: 65 }, (_, j) => {
      const r = CUP.outer * j / 64
      return new THREE.Vector2(r, cupSurface(CUP.x + r, 0).height + .001)
    })
    const cupGlass = glass.clone(); cupGlass.side = THREE.DoubleSide
    const cup = new THREE.Mesh(new THREE.LatheGeometry(profile, 64), cupGlass)
    cup.name = 'glass-start-cup'; cup.position.x = CUP.x; board.add(cup)
    const marbles = [u, ...u.marbles].map((m, j) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(m.radius, 24, 16), sphereGlass)
      mesh.name = j ? `companion-marble-${j}` : 'marble'; mesh.castShadow = true
      const ribbon = new THREE.Mesh(new THREE.TorusGeometry(m.radius * .72, m.radius * .045, 6, 32, Math.PI * 1.6), plastic(['#e6b766', '#82cfb0', '#a8b2e8'][j]))
      ribbon.name = 'marble-colour-ribbon'; ribbon.rotation.y = .7; mesh.add(ribbon)
      board.add(contactPart(mesh, mesh.name, { surface: `board-${n}` })); return mesh
    })
    for (const [x, color] of [[-1.16, '#d9a65e'], [1.16, '#91c76c']] as const) { const goal = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.13, 32), plastic(color)); goal.rotation.x = -Math.PI / 2; goal.position.set(x, 0.045, 0); board.add(goal) }
    return { board, pieces, channels, cursor, marbles, light, u }
  })
  let lastPose = ''
  return { step(colors: readonly (string | null)[] = []) {
    const poses = logic.renderState(), signature = JSON.stringify(poses), changed = signature !== lastPose
    lastPose = signature
    models.forEach((m, n) => {
      const u = m.u, pose = poses[n]; wear(m.light, colors[n] ?? null)
      m.board.rotation.set(pose.tiltZ * 0.08, 0, -pose.tiltX * 0.08)
      m.pieces.forEach((p, j) => { const piece = u.track[j]; p.g.visible = !!piece; if (piece) { p.g.rotation.y = -piece.turn * Math.PI / 2; p.kinds.forEach((a, d) => { a.visible = piece.kind === d }) } })
      for (const channel of m.channels) {
        let count = 0
        for (const piece of m.pieces) if (piece.g.visible && piece.kinds[channel.kind].visible) {
          piece.g.updateMatrix()
          const source = piece.kinds[channel.kind].children[channel.index]; source.updateMatrix()
          channel.mesh.setMatrixAt(count++, channelPose.multiplyMatrices(piece.g.matrix, source.matrix))
        }
        channel.mesh.count = count; channel.mesh.instanceMatrix.needsUpdate = true
      }
      m.cursor.visible = !u.running; m.cursor.position.set((Math.round(u.cursorX) - 2) * RUN.cell, 0.14, (Math.round(u.cursorZ) - 2) * RUN.cell)
      pose.marbles.forEach((body, j) => {
        m.marbles[j].position.set(body.x, body.radius + cupSurface(body.x, body.z).height, body.z)
        m.marbles[j].rotation.set(body.rollX, 0, body.rollZ)
      })
    })
    return changed
  } }
}
export function createView(stage: Stage, logic: MarblerunLogic): DeviceView {
  const m = boards(stage.scene, logic)
  return { framing: playFrame([0, 0.9, 0], 1.85, [0.2, 1.2, 1.1]), overview: playFrame([1.9, 0.8, 0], 3.5), inspect: () => playFrame([0, 0.9, 0], 0.7), follow: n => new THREE.Vector3(n * 3.8, 0.9, 0), update: colors => { if (m.step(colors)) stage.view?.invalidate() } }
}
export function preview() {
  const l = new MarblerunLogic(); l.units[0].track[12] = { kind: 0, turn: 0 }
  return showcase(scene => { const m = boards(scene, l, 1); let previous = 0, pushAt = 0; return { step(t) { if (t >= pushAt) { l.push(0, .55); pushAt = t + 3 } l.step([], Math.max(0, t - previous)); previous = t; m.step() } } }, [0, 0.9, 0], 1.45)
}
