import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderSVG } from 'uqr'
import { rasterize } from './raster.mjs'

afterEach(() => vi.unstubAllGlobals())

describe('the bundled QR worker', () => {
  it('decodes actual pixels and rejects an oversized or malformed frame', async () => {
    const worker = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn() }
    vi.stubGlobal('self', worker)
    await import('../src/controller/qr-worker')
    const frame = await rasterize(renderSVG('1234567890', { border: 4 }), 320)
    worker.onmessage!({ data: { id: 1, width: frame.width, height: frame.height, pixels: frame.data.buffer } })
    expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1, text: '1234567890', corners: expect.arrayContaining([expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })]) }))
    worker.onmessage!({ data: { id: 2, width: 721, height: 1, pixels: new ArrayBuffer(2884) } })
    expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 2, text: null })
    worker.onmessage!({ data: { id: 3, width: 320, height: 320, pixels: new ArrayBuffer(10) } })
    expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 3, text: null })
  })
})
