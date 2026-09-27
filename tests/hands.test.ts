import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { Parts as PartsT, Part } from '../src/viewer/nodes'

// These tests exercise ownership, not rendering; browser suites exercise the real template helper.
vi.mock('../src/ui/markup', () => ({ html: () => null, setMarkup: () => {} }))

// Parts builds its detail card with the DOM; a few stand-ins are enough for selection logic.
beforeAll(() => {
  const el = () => ({ className: '', innerHTML: '', dataset: {}, style: {}, setAttribute() {}, querySelector: () => el(), classList: { toggle() {}, add() {}, remove() {} } })
  Object.assign(globalThis, { document: { createElement: el, body: { appendChild() {} } }, innerWidth: 800, innerHeight: 600 })
})

async function scene() {
  const { Parts } = await import('../src/viewer/nodes')
  const taken: { from: string; part: string }[] = []
  const parts: PartsT = new Parts(new THREE.PerspectiveCamera(), new THREE.Scene(), {
    changed: () => {},
    taken: (from, part) => taken.push({ from: from.id, part: part.title }),
  })
  // A model with two semantic pillars and a plain part.
  const root = new THREE.Group()
  const wrap = new THREE.Group()
  wrap.add(root)
  for (const key of ['time', 'cost']) {
    const node = new THREE.Group()
    node.userData = { isNode: true }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    mesh.userData = { pillarKey: key }
    node.add(mesh)
    root.add(node)
  }
  parts.add(root, wrap, null, 'Trade-off')
  const list = parts.listable()
  const pillar = (t: string) => list.find((p) => p.title === t)!
  return { parts, taken, list, pillar, root }
}

describe('shared scene hands (CATALOGUE §5)', () => {
  it('lists each object, then its semantic parts', async () => {
    const { list } = await scene()
    expect(list.map((p) => `${p.kind}:${p.title}`)).toEqual(['object:Trade-off', 'pillar:Time', 'pillar:Cost'])
  })

  it('gives a part to one hand at a time', async () => {
    const { parts, pillar } = await scene()
    const a = parts.hand('a', '#38bdf8')
    const b = parts.hand('b', '#fb7185')
    expect(parts.select(pillar('Time'), a)).toBe(true)
    expect(parts.select(pillar('Time'), b)).toBe(false)
    expect(parts.holderOf(pillar('Time'))).toBe(a)
    // Another part is free.
    expect(parts.select(pillar('Cost'), b)).toBe(true)
    // Taking a new part lets go of the old one.
    expect(parts.select(pillar('Time'), b)).toBe(false)
    parts.select(null, a)
    expect(parts.select(pillar('Time'), b)).toBe(true)
    expect(parts.holderOf(pillar('Cost'))).toBe(null)
  })

  it('reports a held part when picking what someone else has', async () => {
    const { parts, pillar } = await scene()
    const a = parts.hand('a')
    const b = parts.hand('b')
    parts.select(pillar('Time'), a)
    b.hovered = pillar('Time') as Part
    expect(parts.pickFor(b)).toBe('held')
    expect(b.selected).toBe(null)
  })

  it('lets the screen take a part back, and tells whoever had it', async () => {
    const { parts, pillar, taken } = await scene()
    const a = parts.hand('a')
    parts.select(pillar('Time'), a)
    expect(parts.select(pillar('Time'))).toBe(true)
    expect(parts.holderOf(pillar('Time'))).toBe(parts.host)
    expect(a.selected).toBe(null)
    expect(taken).toEqual([{ from: 'a', part: 'Time' }])
  })

  it('frees what a hand held when its device leaves', async () => {
    const { parts, pillar } = await scene()
    const a = parts.hand('a')
    parts.select(pillar('Cost'), a)
    parts.dropHand('a')
    expect(parts.holderOf(pillar('Cost'))).toBe(null)
    expect(parts.holders()).toEqual([])
  })
})
