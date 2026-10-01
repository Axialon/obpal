import { describe, expect, it } from 'vitest'
import { clampZoom, pinchZoom, zoomCrop, zoomMapping } from '../src/controller/scan-zoom'

describe('scan zoom framing', () => {
  it('uses digital zoom without a usable hardware range', () => {
    expect(zoomMapping(2)).toEqual({ level: 2, hardware: null, digital: 2 })
    expect(zoomMapping(2, { min: 1, max: 1, step: 0 })).toEqual({ level: 2, hardware: null, digital: 2 })
    expect(clampZoom(NaN)).toBe(1)
    expect(clampZoom(10)).toBe(3)
  })
  it('maps constraints to the supported steps and fills the rest digitally', () => {
    expect(zoomMapping(2, { min: 1, max: 4, step: .1 })).toEqual({ level: 2, hardware: 2, digital: 1 })
    expect(zoomMapping(3, { min: 1, max: 2, step: .1 })).toEqual({ level: 3, hardware: 2, digital: 1.5 })
    const mapping = zoomMapping(1.25, { min: 1, max: 2, step: .2 })
    expect(mapping.hardware).toBeCloseTo(1.2)
    expect(mapping.digital * mapping.hardware!).toBeCloseTo(1.25)
    const smallStep = zoomMapping(1.1, { min: 1, max: 2, step: .2 })
    expect(smallStep.hardware).toBe(1)
    expect(smallStep.digital).toBe(1.1)
  })
  it('centres the visible cover crop before magnifying in portrait and landscape', () => {
    expect(zoomCrop(1280, 720, 360, 720, 2)).toEqual({ x: 550, y: 180, width: 180, height: 360 })
    expect(zoomCrop(720, 1280, 720, 360, 2)).toEqual({ x: 180, y: 550, width: 360, height: 180 })
    expect(zoomCrop(1280, 720, 0, 0, 1)).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
  })
  it('scales a pinch from its starting level without accumulating move events', () => {
    expect(pinchZoom(1.5, 100, 150)).toBe(2.25)
    expect(pinchZoom(2, 100, 50)).toBe(1)
    expect(pinchZoom(2, 100, 300)).toBe(3)
    expect(pinchZoom(1.5, 0, 100)).toBe(1.5)
    expect(pinchZoom(1.5, 100, NaN)).toBe(1.5)
  })
})
