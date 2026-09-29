/** Versioned local inference assets. Camera frames are never part of this cache. */
export const HAND_CACHE = 'obpal-hand-vision-1.0.1-model-1'
export const handAsset = (path: string) => /^\/models\/(hand_landmarker\.task|vision_wasm_(?:nosimd_)?internal\.(?:js|wasm))$/.test(path)
/** Unknown networks also ask: Safari cannot tell us whether the phone is on cellular. */
export const constrainedDownload = (connection?: { saveData?: boolean; type?: string }) => connection?.saveData === true || !['wifi', 'ethernet'].includes(connection?.type ?? '')

export async function handAssetsCached() {
  try {
    const cache = await caches.open(HAND_CACHE)
    const has = async (path: string) => !!await cache.match(`/models/${path}`)
    return await has('hand_landmarker.task') && ((await has('vision_wasm_internal.wasm') && await has('vision_wasm_internal.js')) || (await has('vision_wasm_nosimd_internal.wasm') && await has('vision_wasm_nosimd_internal.js')))
  } catch { return false }
}

/** Stream progress and retain a complete response only. Interrupted downloads cannot look cached. */
export async function cacheHandAsset(path: string, progress: (bytes: number) => void = () => {}) {
  let cache: Cache | undefined
  try { cache = await caches.open(HAND_CACHE); const hit = await cache.match(path); if (hit) return hit } catch { /* storage can be disabled */ }
  const response = await fetch(path, { cache: 'force-cache' })
  if (!response.ok) throw new Error('Hand asset unavailable')
  const reader = response.body?.getReader()
  if (!reader) return response
  const chunks: Uint8Array<ArrayBuffer>[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value); progress(value.byteLength)
  }
  const complete = new Response(new Blob(chunks), { headers: response.headers, status: response.status })
  try { await cache?.put(path, complete.clone()) } catch { /* tracking still works without persistent storage */ }
  return complete
}
