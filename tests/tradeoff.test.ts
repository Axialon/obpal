import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { formatValue, Tradeoff } from '../src/viewer/tradeoff'
import { models } from '../src/vendor/blackboxes'
import { boxemCore } from '../src/viewer/boxem-core'

// The model tests need no rendered tags; browser suites cover their DOM.
vi.mock('../src/ui/markup', () => ({ html: () => null, setMarkup: () => {} }))

// Minimal DOM for the value tags (the test runs in node).
const el = () => {
  const kids: Record<string, { textContent: string }> = {}
  return {
    className: '', innerHTML: '', style: { setProperty() {}, transform: '', visibility: '', zIndex: '' }, classList: { toggle() {} },
    querySelector: (s: string) => (kids[s] ??= { textContent: '' }),
  }
}
beforeAll(() => {
  Object.assign(globalThis, { document: { createElement: el }, innerWidth: 1200, innerHeight: 800 })
})

const KEYS = ['sla', 'budget', 'compute', 'latency', 'complexity', 'security']
const DIRS = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((d) => new THREE.Vector3(...d))

/** An Orbit'em-shaped model: six pillars on axes, label anchors, twelve links and a one-vertex-per-pillar hull. */
function orbitem() {
  const root = new THREE.Group()
  const nodes = KEYS.map((k, i) => {
    const n = new THREE.Group()
    n.name = `node-${k}`
    n.userData = { pillarKey: k, isNode: true }
    n.position.copy(DIRS[i]).multiplyScalar(1.5)
    n.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.2), new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x0e7490 })))
    root.add(n)
    const anchor = new THREE.Object3D()
    anchor.position.copy(DIRS[i]).multiplyScalar(1.5 * 1.36)
    root.add(anchor)
    return n
  })
  const linkGroup = new THREE.Group()
  root.add(linkGroup)
  const pairs: [number, number][] = [[0, 1], [0, 2], [0, 4], [0, 5], [3, 1], [3, 2], [3, 4], [3, 5], [1, 4], [4, 2], [2, 5], [5, 1]]
  for (const [a, b] of pairs) {
    const l = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1), new THREE.MeshBasicMaterial())
    l.userData = { k1: KEYS[a], k2: KEYS[b] }
    linkGroup.add(l)
  }
  const verts: number[] = []
  const faces = [[0, 1, 4], [0, 4, 2], [0, 2, 5], [0, 5, 1], [3, 4, 1], [3, 2, 4], [3, 5, 2], [3, 1, 5]]
  for (const f of faces) for (const i of f) verts.push(...DIRS[i].clone().multiplyScalar(1.5 * 0.78).toArray())
  const hull = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)), new THREE.MeshStandardMaterial())
  root.add(hull)
  root.updateMatrixWorld(true)
  return { root, nodes, hull, linkGroup }
}
const overlay = () => ({ replaceChildren() {}, appendChild() {} }) as unknown as HTMLElement
const settle = (t: Tradeoff, cam: THREE.Camera) => { for (let i = 0; i < 200; i++) t.update(1 / 30, cam) }

describe('Tradeoff', () => {
  const cam = new THREE.PerspectiveCamera(45, 1.5, 0.1, 100)
  cam.position.set(0, 0.5, 8)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)

  it('attaches to a model with pillars of a known engine, and only then', () => {
    expect(Tradeoff.attach(orbitem().root, 'orbitem', overlay())).not.toBeNull()
    expect(Tradeoff.attach(orbitem().root, null, overlay())).toBeNull()
    expect(Tradeoff.attach(new THREE.Group(), 'orbitem', overlay())).toBeNull()
  })

  it('starts at the canonical defaults, in the authored pose', () => {
    const m = orbitem()
    const t = Tradeoff.attach(m.root, 'orbitem', overlay())!
    const d = models.defaults('orbitem')
    expect(t.value('budget')).toBe(d.monthlyBudget)
    settle(t, cam)
    for (const n of m.nodes) expect(n.position.length()).toBeCloseTo(1.5, 5)
  })

  it('re-solves the model when one pillar changes, and moves every piece with it', () => {
    const m = orbitem()
    const t = Tradeoff.attach(m.root, 'orbitem', overlay())!
    const before = Object.fromEntries(KEYS.map((k) => [k, t.value(k)]))
    expect(t.set('budget', 1200)).toBe(true)
    expect(t.value('budget')).toBe(1200)
    expect(KEYS.filter((k) => k !== 'budget' && t.value(k) !== before[k]).length).toBeGreaterThan(0)
    settle(t, cam)
    const budget = m.nodes[1]
    expect(budget.position.length()).toBeGreaterThan(1.5)
    // links span their two pillars
    m.root.updateMatrixWorld(true)
    for (const l of m.linkGroup.children) {
      const a = m.nodes[KEYS.indexOf(l.userData.k1)].position, b = m.nodes[KEYS.indexOf(l.userData.k2)].position
      expect(l.position.distanceTo(a.clone().add(b).multiplyScalar(0.5))).toBeLessThan(1e-6)
      expect(l.scale.y).toBeCloseTo(a.distanceTo(b), 6)
    }
    // the hull keeps each vertex at its share of its pillar
    const pos = (m.hull.geometry as THREE.BufferGeometry).getAttribute('position')
    const v = new THREE.Vector3().fromBufferAttribute(pos, 1) // faces[0][1] = budget
    expect(v.distanceTo(budget.position.clone().multiplyScalar(0.78))).toBeLessThan(1e-4)
  })

  it('rejects values the model cannot satisfy, leaving the state untouched', () => {
    const t = Tradeoff.attach(orbitem().root, 'orbitem', overlay())!
    const state = JSON.stringify(t.state)
    expect(t.set('budget', Number.NaN)).toBe(false)
    expect(JSON.stringify(t.state)).toBe(state)
  })

  it('turns a drag along the pillar axis on screen into a value change, and resets', () => {
    const m = orbitem()
    const t = Tradeoff.attach(m.root, 'orbitem', overlay())!
    const v0 = t.value('sla')
    expect(t.nudge('sla', 0, -60, cam)).toBe(true) // sla points up: dragging up raises it
    expect(t.value('sla')).toBeGreaterThan(v0)
    t.reset('sla')
    expect(t.value('sla')).toBeCloseTo(v0, 9)
    expect(t.drive('compute', 1, 0.5)).toBe(true)
    t.reset()
    expect(t.value('compute')).toBe(models.defaults('orbitem').computeCapacity)
  })
})

describe("Box'em core", () => {
  it('is a live model: more scope moves budget or time, and every hull vertex tracks its pillar', () => {
    const root = boxemCore()
    const t = Tradeoff.attach(root, 'boxem', overlay())!
    expect(t).not.toBeNull()
    const before = { cost: t.value('cost'), time: t.value('time') }
    expect(t.set('scope', 150)).toBe(true)
    expect(t.value('scope')).toBe(150)
    expect(t.value('cost') !== before.cost || t.value('time') !== before.time).toBe(true)
    const cam = new THREE.PerspectiveCamera(45, 1.5, 0.1, 100)
    cam.position.set(0, 0, 8)
    for (let i = 0; i < 200; i++) t.update(1 / 30, cam)
    const scope = root.getObjectByName('node-scope')!
    expect(scope.position.length()).toBeGreaterThan(1.5)
  })
})

describe('formatValue', () => {
  it('reads like the engines', () => {
    expect(formatValue(8500, 'USD')).toBe('$8,500')
    expect(formatValue(7_500_000, 'USD')).toBe('$7.5M')
    expect(formatValue(450, 'USD/month')).toBe('$450/mo')
    expect(formatValue(99.95, '%')).toBe('99.95%')
    expect(formatValue(88, '%')).toBe('88%')
    expect(formatValue(4, 'weeks')).toBe('4 wks')
    expect(formatValue(45.4, 'ms')).toBe('45 ms')
    expect(formatValue(0.85, 'ratio')).toBe('×0.85')
  })
})
