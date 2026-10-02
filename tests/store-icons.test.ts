import { describe, expect, it } from 'vitest'
import { readBytes, toolbarMark, iconFixtures, referencePixels, compareIcon, oldStoreIcon, alphaPixels } from './store-node.mjs'

const { source, icons } = await iconFixtures()
// Independent rasterisation of the canonical SVG, rather than the extension renderer's downsampling path.
const reference = await referencePixels()

describe('Link icons keep the family mark', () => {
  it.each([16, 32, 48, 128])('compares silhouette and colours at a common art size for %i px', async size => {
    const png = icons.find((i: { size: number }) => i.size === size)!.png
    const difference = await compareIcon(png, size === 128 ? 16 : 0, reference)
    // Small pixels and their modest stroke lift allow more coverage error; larger art keeps the normal weights.
    expect(difference.silhouette).toBeGreaterThan(size === 16 ? 0.76 : size === 32 ? 0.88 : size === 48 ? 0.91 : 0.98)
    expect(difference.colourMean).toBeLessThan(size === 16 ? 16 : size === 32 ? 9 : size === 48 ? 6 : 2)
  })
  it.each([['public/icon-192.png', 4], ['public/icon-512.png', 10], ['extension/store/icon-128.png', 16]] as const)('matches the same mark in %s', async (path, pad) => {
    const difference = await compareIcon(path, pad, reference)
    expect(difference.silhouette).toBeGreaterThan(0.98)
    expect(difference.colourMean).toBeLessThan(2)
  })
  it('rejects the older store redraw with its different cube and rim', async () => {
    const difference = await compareIcon(oldStoreIcon(), 16, reference)
    expect(difference.silhouette < 0.98 || difference.colourMean > 2).toBe(true)
  })
  it('changes only small stroke weights, and leaves larger SVGs exact', () => {
    const withoutWeights = (svg: string) => svg.replace(/stroke-width="[\d.]+"/g, '')
    for (const size of [16, 32]) expect(withoutWeights(toolbarMark(source, size))).toBe(withoutWeights(source))
    for (const size of [48, 128]) expect(toolbarMark(source, size)).toBe(source)
  })
  it('leaves exactly 16 transparent pixels around the 96 px store art', async () => {
    const data = await alphaPixels(icons.find((i: { size: number }) => i.size === 128)!.png)
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      if (x < 16 || x >= 112 || y < 16 || y >= 112) expect(data[(y * 128 + x) * 4 + 3]).toBe(0)
    }
    expect(readBytes('extension/store/icon-128.png')).toEqual(new Uint8Array(icons.find((i: { size: number }) => i.size === 128)!.png))
  })
})
