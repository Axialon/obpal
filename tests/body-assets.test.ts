import { afterEach, describe, expect, it, vi } from 'vitest'
import { BODY_CACHE, BODY_MODEL, bodyAsset, bodyAssetsCached, cacheBodyAsset } from '../src/controller/body-assets'
import { route } from '../src/sw/routes'
afterEach(() => vi.unstubAllGlobals())
describe('body inference asset cache', () => {
  it('allows only Lite revision assets, with a dedicated service worker route', async () => {
    expect(bodyAsset(BODY_MODEL)).toBe(true)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    for (const path of ['/models/pose_landmarker_full.task', '/models/frame.png', '/api/body', 'https://other.test/models/pose_landmarker_lite.task']) {
      expect(bodyAsset(path)).toBe(false); await expect(cacheBodyAsset(path)).rejects.toThrow()
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(route({ url: `https://test.example${BODY_MODEL}`, method: 'GET', mode: 'cors' }, 'https://test.example', new Set())).toBe('body-model')
  })
  it('caches static GET responses, never a failed response, and needs a complete runtime', async () => {
    const files = new Map<string, Response>()
    const cache = { match: vi.fn(async (p: string) => files.get(p)?.clone()), put: vi.fn(async (p: string, r: Response) => { files.set(p, r) }) }
    const open = vi.fn(async () => cache); vi.stubGlobal('caches', { open })
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))); vi.stubGlobal('fetch', fetch)
    expect(await bodyAssetsCached()).toBe(false)
    await cacheBodyAsset(BODY_MODEL); expect(open).toHaveBeenCalledWith(BODY_CACHE)
    await cacheBodyAsset(BODY_MODEL); expect(fetch).toHaveBeenCalledTimes(1)
    await cacheBodyAsset('/models/vision-1.0.1/vision_wasm_internal.js'); expect(await bodyAssetsCached()).toBe(false)
    await cacheBodyAsset('/models/vision_wasm_internal.wasm'); expect(await bodyAssetsCached()).toBe(true)
    fetch.mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(cacheBodyAsset('/models/vision-1.0.1/vision_wasm_nosimd_internal.js')).rejects.toThrow()
    expect(files.has('/models/vision-1.0.1/vision_wasm_nosimd_internal.js')).toBe(false)
    expect(fetch).toHaveBeenCalledWith(BODY_MODEL, { cache: 'force-cache' })
  })
})
