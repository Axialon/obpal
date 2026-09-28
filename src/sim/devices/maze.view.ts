import { contactPart, contactSurface } from '../contact'
/**
 * The maze boards' look (three.js): four boards on pedestals, each tilting as its player tilts it, with the maze's walls,
 * its holes and the lit goal, and a glass marble with a core in its player's colour.
 */
import * as THREE from 'three'
import { ceramic, darkTitanium } from '../kit/surfaces'
import { pov, tiledDeck } from '../kit/precision'
import { batch, bolt, cylinder, maker, rounded } from '../kit'
import { MAZE, MazeLogic, makeMaze, stepBoard, type Board, type Maze } from './maze'
import type { Stage } from './stage'
import type { Theme } from '../../ui/themes'
import { box, mats, plate, previewScene, wear, type DeviceView, type Preview } from './view'

/** Where each board stands: two by two. */
export const BOARD_AT: [number, number][] = [[-0.98, -0.94], [0.98, -0.94], [-0.98, 1], [0.98, 1]]
const LIFT = 0.16

interface BoardModel { root: THREE.Group; tray: THREE.Group; marble: THREE.Group; core: THREE.MeshStandardMaterial; rim: THREE.MeshStandardMaterial; goal: THREE.MeshStandardMaterial; base: THREE.MeshStandardMaterial }

function buildBoard(m: Maze, n: number): BoardModel {
  const root = new THREE.Group()
  const S = MAZE.size
  // A pedestal the board pivots on.
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, LIFT, 24), mats.dark())
  post.position.y = LIFT / 2
  post.castShadow = true
  root.name = `maze-${n + 1}`; root.add(contactPart(post, 'pedestal'))
  const tray = new THREE.Group()
  tray.position.y = LIFT
  root.add(tray)
  const baseMat = new THREE.MeshStandardMaterial({ color: '#3d484f', roughness: .24, metalness: .9 })
  const base = box(S + 0.08, 0.04, S + 0.08, baseMat, 0.02)
  base.position.y = -0.02
  tray.add(contactSurface(base, `board-${n}`))
  const oak = darkTitanium
  for (const side of [-1, 1]) {
    const rail = box(S + 0.14, 0.07, 0.055, oak, 0.01); rail.position.set(0, 0.01, side * (S / 2 + 0.035)); tray.add(rail)
    const end = box(0.055, 0.07, S + 0.03, oak, 0.01); end.position.set(side * (S / 2 + 0.035), 0.01, 0); tray.add(end)
    const knob = cylinder(0.045, 0.045, mats.dark(), 24); knob.rotation.z = Math.PI / 2; knob.position.set(side * (S / 2 + 0.09), -0.01, 0); tray.add(knob)
    for (const z of [-1, 1]) { const screw = bolt(0.009); screw.position.set(side * (S / 2 + 0.03), 0.049, z * (S / 2 + 0.03)); tray.add(screw) }
  }
  maker(tray, 0.2, 0.049, S / 2 + 0.036, 0.04)
  const rim = mats.glow()
  const frame = new THREE.Mesh(new THREE.TorusGeometry(1, 0.006, 6, 4), darkTitanium)
  frame.rotation.set(Math.PI / 2, 0, Math.PI / 4)
  frame.scale.setScalar(((S + 0.08) / 2) * Math.SQRT2)
  frame.position.y = 0.002
  tray.add(frame)
  const status = box(.09, .003, .015, rim); status.position.set(-.1, .049, S / 2 + .036); tray.add(status)
  pov(tray, [0, .35, S / 2], [0, -.35, -1])
  // The walls: one instanced box per wall.
  const wallMat = ceramic
  const walls = new THREE.InstancedMesh(rounded(1, 1, 1, 0.08), wallMat, m.walls.length)
  const H = 0.045
  const mtx = new THREE.Matrix4()
  m.walls.forEach((w, i) => walls.setMatrixAt(i, mtx.compose(new THREE.Vector3(w.x, H / 2, w.z), new THREE.Quaternion(), new THREE.Vector3(w.hx * 2, H, w.hz * 2))))
  tray.add(walls)
  walls.castShadow = walls.receiveShadow = true
  // Holes: dark wells with a lip; the goal lit.
  const well = new THREE.MeshBasicMaterial({ color: '#05060a' })
  for (const [x, z] of m.holes) {
    const hole = new THREE.Mesh(new THREE.CircleGeometry(MAZE.hole, 32), well)
    hole.rotation.x = -Math.PI / 2
    hole.position.set(x, 0.001, z)
    const lip = new THREE.Mesh(new THREE.TorusGeometry(MAZE.hole, 0.004, 6, 40), mats.dark())
    lip.rotation.x = Math.PI / 2
    lip.position.set(x, 0.002, z)
    tray.add(hole, lip)
  }
  const goal = new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: '#c6ff34', emissiveIntensity: 1.6 })
  const g1 = new THREE.Mesh(new THREE.TorusGeometry(MAZE.hole, 0.007, 8, 48), goal)
  g1.rotation.x = Math.PI / 2
  g1.position.set(m.goal[0], 0.003, m.goal[1])
  const g2 = new THREE.Mesh(new THREE.CircleGeometry(MAZE.hole * 0.92, 32), new THREE.MeshBasicMaterial({ color: '#0e1405' }))
  g2.rotation.x = -Math.PI / 2
  g2.position.set(m.goal[0], 0.0015, m.goal[1])
  tray.add(g1, g2)
  const start = new THREE.Mesh(new THREE.RingGeometry(0.032, 0.04, 32), new THREE.MeshBasicMaterial({ color: '#9aa4b5', transparent: true, opacity: 0.5 }))
  start.rotation.x = -Math.PI / 2
  start.position.set(m.start[0], 0.002, m.start[1])
  tray.add(start)
  const num = plate(n + 1, 0.09)
  num.position.set(-S / 2 + 0.02, 0.004, S / 2 + 0.025)
  num.rotation.x = -Math.PI / 2
  num.scale.setScalar(0.8)
  tray.add(num)
  // The marble: clear glass round a core in its player's colour.
  const marble = new THREE.Group()
  const core = new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: '#9aa4b5', emissiveIntensity: 1 })
  marble.add(new THREE.Mesh(new THREE.SphereGeometry(MAZE.ball * 0.5, 20, 14), core))
  marble.add(new THREE.Mesh(new THREE.SphereGeometry(MAZE.ball, 24, 16), new THREE.MeshPhysicalMaterial({ color: '#dfe8ff', metalness: 0.94, roughness: 0.13, clearcoat: 0.5, envMapIntensity: 1.6 })))
  marble.children.forEach(part => { part.castShadow = true })
  batch(tray, [marble, walls, base])
  tray.add(contactPart(marble, 'marble', { surface: `board-${n}`, mode: () => marble.scale.x < .999 ? 'free' : 'touch' }))
  return { root, tray, marble, core, rim, goal, base: baseMat }
}

function placeBoard(m: BoardModel, b: Board, color: string | null, t: number) {
  m.tray.rotation.set(b.tz, 0, -b.tx)
  const r = MAZE.ball
  const sink = b.falling ? Math.min(1, b.falling / 0.5) : 0
  m.marble.position.set(b.mx, r - sink * r * 2.2, b.mz)
  m.marble.scale.setScalar(1 - sink * 0.6)
  // Rolling: the marble turns as it goes (about the axis across its way).
  m.marble.rotation.x += b.vz / r / 60
  m.marble.rotation.z -= b.vx / r / 60
  wear(m.core, color, 0.9, 2.4)
  wear(m.rim, color, 0.4, 1.8)
  m.goal.emissiveIntensity = b.won ? 3 + Math.sin(t * 14) : 1.4 + 0.3 * Math.sin(t * 2.5)
}

export function createView(stage: Stage, logic: MazeLogic): DeviceView {
  const models = logic.boards.map((_, n) => {
    const m = buildBoard(logic.maze, n)
    const [x, z] = BOARD_AT[n] ?? [0, 0]
    m.root.position.set(x, 0, z)
    stage.scene.add(m.root)
    return m
  })
  stage.scene.add(tiledDeck(4.25, 4.3, 0, 1))
  const setTheme = (t: Theme) => { for (const m of models) m.base.color.set(t.light ? '#8a9499' : '#3d484f') }
  setTheme(stage.theme)
  return {
    framing: (() => { const [x, z] = BOARD_AT[0]; return { target: [x, LIFT, z], wide: [x, 2.5, z + 2], tall: [x, 3, z + 1.6], radius: 0.92, min: 0.6, max: 12 } })(),
    inspect() { const [x, z] = BOARD_AT[0]; return { target: [x, LIFT, z], wide: [x, 2.5, z + 2], tall: [x, 3, z + 1.6], radius: 0.92, min: 0.6, max: 12 } },
    overview: { target: [0, 0.1, 0.1], wide: [0, 5.1, 4.25], tall: [0, 6.5, 3.8], radius: 2.15, min: 0.8, max: 12 },
    update(colors, t) { logic.boards.forEach((b, n) => placeBoard(models[n], b, colors[n], t)) },
    setTheme,
  }
}

/** The card: one board tilting on its own, the marble rolling along the walls. */
export function preview(): Preview {
  const scene = previewScene()
  const maze = makeMaze(7)
  const m = buildBoard(maze, 0)
  m.base.color.set('#3d484f')
  scene.add(m.root)
  const camera = new THREE.PerspectiveCamera(34, 16 / 10, 0.05, 20)
  camera.position.set(0, 2.3, 2.2)
  camera.lookAt(0, 0.1, 0.02)
  const b: Board = { tx: 0, tz: 0, mx: maze.start[0], mz: maze.start[1], vx: 0, vz: 0, falling: 0, won: 0, running: false, time: 0, best: null, level: null }
  return {
    scene, camera,
    step(t, dt) {
      const tilt: [number, number] = [Math.sin(t * 0.8) * MAZE.maxTilt, Math.cos(t * 0.55) * MAZE.maxTilt]
      const r = stepBoard(b, maze, tilt, dt)
      // Down a hole or home, it starts over at once.
      if (r === 'fell' || r === 'won') Object.assign(b, { mx: maze.start[0], mz: maze.start[1], vx: 0, vz: 0, falling: 0, won: 0 })
      placeBoard(m, b, '#c6ff34', t)
    },
  }
}
