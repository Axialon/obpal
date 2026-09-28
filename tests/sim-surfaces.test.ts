import { describe, expect, it } from 'vitest'
import { Box3, Raycaster, Vector3 } from 'three'
import { tiledDeck } from '../src/sim/kit/precision'

describe('tiled surfaces', () => {
  it.each([.031, .14])('keeps a %s m deck inside its envelope with distinct visible layers', depth => {
    const top = -.004, deck = tiledDeck(3.2, 2.8, top, .48, depth)
    deck.updateMatrixWorld(true)
    const bounds = new Box3().setFromObject(deck)
    expect(bounds.max.y).toBeCloseTo(top, 6)
    expect(bounds.min.y).toBeCloseTo(top - depth, 6)
    const size = bounds.getSize(new Vector3())
    expect(size.x).toBeCloseTo(3.2, 6)
    expect(size.z).toBeCloseTo(2.8, 6)
    // Rays through tile interiors must see a single finish before the recessed substrate.
    // Two broad faces at the same depth fight even with a healthy camera near/far range.
    for (const x of [-1.3, -.7, .1, .9, 1.4]) for (const z of [-1.1, -.5, .15, .7, 1.15]) {
      const hits = new Raycaster(new Vector3(x, 1, z), new Vector3(0, -1, 0)).intersectObject(deck, true)
      const surfaces = hits.filter(hit => hit.face!.normal.y > .99)
      expect(surfaces.length).toBe(2)
      expect(surfaces[0].point.y).toBeCloseTo(top, 6)
      expect(surfaces[1].point.y).toBeCloseTo(top - .006, 6)
    }
    expect(deck.children).toHaveLength(2)
  })

  it('keeps the existing thin floor depth when no workbench depth is requested', () => {
    const floor = tiledDeck(4, 3)
    expect(new Box3().setFromObject(floor).getSize(new Vector3()).y).toBeCloseTo(.031, 6)
  })
})
