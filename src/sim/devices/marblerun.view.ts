import * as THREE from 'three'
import { batch, floorMaterial, metal, plastic } from '../kit'
import { MarblerunLogic, RUN, trackEnds } from './marblerun'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'

function boards(scene: THREE.Scene, logic: MarblerunLogic, count = 2) {
  const models = logic.units.slice(0, count).map((u, n) => {
    const base = new THREE.Group(); base.name = `track-pedestal-${n + 1}`; base.position.x = n * 3.8; scene.add(base)
    block(base, [3.3, 0.08, 3.3], [0, -0.05, 0], floorMaterial('#4b5859'))
    disc(base, 0.7, 0.18, [0, 0.09, 0], plastic('#445563')); rod(base, [0, 0.1, 0], [0, 0.8, 0], 0.15, metal); batch(base)
    const board = new THREE.Group(); board.name = 'tilting-build-board'; board.position.y = 0.9; base.add(board)
    block(board, [3.05, 0.12, 3.05], [0, -0.08, 0], plastic('#c8b69c'))
    const light = mats.glow(); block(board, [0.45, 0.01, 0.08], [0, 0, 1.48], light)
    for (let k = 0; k <= 5; k++) {
      const at = (k - 2.5) * RUN.cell
      block(board, [0.008, 0.003, 2.9], [at, 0, 0], plastic('#8b8171')); block(board, [2.9, 0.003, 0.008], [0, 0, at], plastic('#8b8171'))
    }
    batch(board)
    const pieces = Array.from({ length: 25 }, (_, j) => {
      const g = new THREE.Group(); g.name = `channel-${j + 1}`; g.position.set((j % 5 - 2) * RUN.cell, 0.025, (Math.floor(j / 5) - 2) * RUN.cell); board.add(g)
      const kinds = [0, 1].map(kind => {
        const shape = new THREE.Group(); shape.name = kind ? 'bend' : 'straight'; g.add(shape)
        block(shape, [0.36, 0.025, 0.36], [0, 0, 0], plastic('#98babe'))
        for (const d of trackEnds({ kind, turn: 0 })) {
          const arm = new THREE.Group(); arm.rotation.y = -d * Math.PI / 2; arm.userData.static = true; shape.add(arm)
          block(arm, [0.29, 0.024, 0.36], [0.145, 0, 0], plastic('#98babe'))
          for (const z of [-0.18, 0.18]) block(arm, [0.29, 0.085, 0.025], [0.145, 0.025, z], plastic('#dce6d7'))
        }
        batch(shape); return shape
      })
      return { g, kinds }
    })
    const cursor = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.25, 32), plastic('#e6b766')); cursor.name = 'build-cursor'; cursor.rotation.x = -Math.PI / 2; board.add(cursor)
    const marble = new THREE.Mesh(new THREE.SphereGeometry(RUN.radius, 24, 16), metal); marble.name = 'marble'; board.add(marble)
    for (const [x, color] of [[-1.16, '#d9a65e'], [1.16, '#91c76c']] as const) { const goal = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.13, 32), plastic(color)); goal.rotation.x = -Math.PI / 2; goal.position.set(x, 0.045, 0); board.add(goal) }
    return { board, pieces, cursor, marble, light, u }
  })
  return { step(colors: readonly (string | null)[] = []) {
    models.forEach((m, n) => {
      const u = m.u; wear(m.light, colors[n] ?? null)
      m.board.rotation.set(u.tiltZ * 0.08, 0, -u.tiltX * 0.08)
      m.pieces.forEach((p, j) => { const piece = u.track[j]; p.g.visible = !!piece; if (piece) { p.g.rotation.y = -piece.turn * Math.PI / 2; p.kinds.forEach((a, d) => { a.visible = piece.kind === d }) } })
      m.cursor.visible = !u.running; m.cursor.position.set((Math.round(u.cursorX) - 2) * RUN.cell, 0.14, (Math.round(u.cursorZ) - 2) * RUN.cell)
      m.marble.position.set(u.x, RUN.radius + 0.043, u.z)
    })
  } }
}
export function createView(stage: Stage, logic: MarblerunLogic): DeviceView {
  const m = boards(stage.scene, logic)
  return { framing: playFrame([0, 0.9, 0], 1.85, [0.2, 1.2, 1.1]), overview: playFrame([1.9, 0.8, 0], 3.5), inspect: () => playFrame([0, 0.9, 0], 0.7), follow: n => new THREE.Vector3(n * 3.8, 0.9, 0), update: colors => m.step(colors) }
}
export function preview() {
  const l = new MarblerunLogic(); l.units[0].track[12] = { kind: 0, turn: 0 }
  return showcase(scene => { const m = boards(scene, l, 1); return { step(t) { l.units[0].x = Math.sin(t) * 1.16; l.units[0].tiltX = Math.cos(t) * 0.6; m.step() } } }, [0, 0.9, 0], 1.45)
}
