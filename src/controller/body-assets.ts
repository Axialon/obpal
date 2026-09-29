/** Only static inference assets can enter this cache. Capture data has no persistence path. */
export const BODY_CACHE = 'obpal-body-vision-1.0.1-lite-1'
export const BODY_MODEL = '/models/pose_landmarker_lite.task'
const runtime = ['vision_wasm_internal', 'vision_wasm_nosimd_internal']
export const bodyLoader = (path: string) => path.replace('/models/', '/models/vision-1.0.1/')
export const bodyAsset = (path: string) => path === BODY_MODEL || runtime.some(n => path === bodyLoader(`/models/${n}.js`) || path === `/models/${n}.wasm`)

export async function bodyAssetsCached() {
  try {
    const cache = await caches.open(BODY_CACHE)
    if (!await cache.match(BODY_MODEL)) return false
    for (const n of runtime) if (await cache.match(bodyLoader(`/models/${n}.js`)) && await cache.match(`/models/${n}.wasm`)) return true
  } catch { /* private browsing can deny model storage */ }
  return false
}

export async function cacheBodyAsset(path: string, progress: (bytes: number) => void = () => {}) {
  if (!bodyAsset(path)) throw new TypeError('Not a body inference asset')
  let cache: Cache | undefined
  try { cache = await caches.open(BODY_CACHE); const hit = await cache.match(path); if (hit) return hit } catch { /* caching is optional */ }
  const response = await fetch(path, { cache: 'force-cache' })
  if (!response.ok) throw new Error('Body asset unavailable')
  const reader = response.body?.getReader()
  if (!reader) return response
  const chunks: Uint8Array<ArrayBuffer>[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value); progress(value.byteLength)
  }
  const complete = new Response(new Blob(chunks), { status: response.status, headers: response.headers })
  try { await cache?.put(path, complete.clone()) } catch { /* inference can run without persistent storage */ }
  return complete
}
