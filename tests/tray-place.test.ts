import { describe, expect, it } from 'vitest'
import { placeTrayCard } from '../src/ui/kit/place'

describe('tray cards inside the usable visual viewport', () => {
  it('measures the full theme card and clamps the reported phone overflow', () => {
    const at = placeTrayCard({ left: 313, top: 615, width: 44, height: 44 }, { width: 280, height: 262 }, { left: 0, top: 64, width: 375, height: 748 })
    expect(at.left).toBe(21)
    expect(at.top + 262).toBeLessThanOrEqual(800)
    expect(at.maxHeight).toBe(724)
  })
  it('centres a tooltip on its button and flips to the free side', () => {
    const bounds = { left: 0, top: 64, width: 844, height: 326 }
    expect(placeTrayCard({ left: 760, top: 200, width: 44, height: 44 }, { width: 180, height: 60 }, bounds)).toMatchObject({ left: 568, top: 192 })
    expect(placeTrayCard({ left: 20, top: 200, width: 44, height: 44 }, { width: 180, height: 60 }, bounds).left).toBe(76)
  })
  it('centres a narrow sheet on the column instead of the last button', () => {
    const at = placeTrayCard({ left: 300, top: 650, width: 44, height: 44 }, { width: 336, height: 330 },
      { left: 0, top: 64, width: 360, height: 656 }, { sheet: true, column: { left: 292, top: 258, width: 60, height: 372 } })
    expect(at).toMatchObject({ left: 12, top: 279, maxWidth: 336, maxHeight: 632 })
  })
  it('respects offset viewports, safe areas and reserved top and bottom bars', () => {
    const at = placeTrayCard({ left: 500, top: 450, width: 44, height: 44 }, { width: 280, height: 262 }, { left: 60, top: 120, width: 360, height: 300 })
    expect(at.left).toBeGreaterThanOrEqual(72)
    expect(at.left + 280).toBeLessThanOrEqual(408)
    expect(at.top).toBeGreaterThanOrEqual(132)
    expect(at.top + 262).toBeLessThanOrEqual(408)
  })
  it('limits an oversized card only to the available space, without a minimum that could overflow', () => {
    const at = placeTrayCard({ left: 270, top: 80, width: 44, height: 44 }, { width: 360, height: 500 }, { left: 0, top: 64, width: 320, height: 180 })
    expect(at).toEqual({ left: 12, top: 76, maxWidth: 296, maxHeight: 156 })
  })
  it('moves above the pairing pill instead of leaving a last-row control behind it', () => {
    const at = placeTrayCard({ left: 730, top: 290, width: 44, height: 44 }, { width: 420, height: 190 },
      { left: 0, top: 64, width: 844, height: 326 }, { avoid: [{ left: 550, top: 310, width: 230, height: 56 }] })
    expect(at.top + 190).toBeLessThanOrEqual(298)
    expect(at.maxHeight).toBeGreaterThanOrEqual(190)
  })
  it.each([[360, 740], [375, 812], [390, 844], [430, 932], [844, 390]])('fits the entire card at %i × %i', (width, height) => {
    const at = placeTrayCard({ left: width - 64, top: height * .75, width: 44, height: 44 }, { width: Math.min(360, width - 24), height: 280 },
      { left: 0, top: 64, width, height: height - 64 }, { sheet: width < 480 })
    expect(at.left).toBeGreaterThanOrEqual(12)
    expect(at.top).toBeGreaterThanOrEqual(76)
    expect(at.top + 280).toBeLessThanOrEqual(height - 12)
  })
})
