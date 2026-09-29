/** The model and camera frames stay in this worker on the phone. Only its landmark result returns to the UI. */
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { cacheHandAsset } from './hand-assets'

let tracker: HandLandmarker | null = null
let delegate: 'GPU' | 'CPU' = 'GPU'
let files: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>
let model: Uint8Array
async function create(using: 'GPU' | 'CPU') {
  return HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetBuffer: model, delegate: using },
    runningMode: 'VIDEO', numHands: 1, minHandDetectionConfidence: .65, minHandPresenceConfidence: .65, minTrackingConfidence: .6,
  })
}

self.onmessage = async (event: MessageEvent<{ type: 'start' | 'frame'; frame?: ImageBitmap; at: number; capture: number }>) => {
  const m = event.data
  if (m.type === 'start') {
    try {
      files = await FilesetResolver.forVisionTasks('/models')
      let bytes = 0
      const progress = (n: number) => { bytes += n; self.postMessage({ type: 'progress', value: Math.min(.99, bytes / 19_500_000) }) }
      const [asset, binary] = await Promise.all([
        cacheHandAsset('/models/hand_landmarker.task', progress),
        cacheHandAsset(files.wasmBinaryPath, progress),
        cacheHandAsset(files.wasmLoaderPath, progress),
      ])
      model = new Uint8Array(await asset.arrayBuffer())
      // The runtime fetches its binary internally. Serve the bytes already fetched and cached above.
      const nativeFetch = self.fetch.bind(self)
      self.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, self.location.href)
        return url.origin === self.location.origin && url.pathname === files.wasmBinaryPath ? Promise.resolve(binary.clone()) : nativeFetch(input, init)
      }) as typeof fetch
      self.postMessage({ type: 'progress', value: 1 })
      try { tracker = await create('GPU') }
      catch { delegate = 'CPU'; tracker = await create('CPU') }
      self.postMessage({ type: 'ready', delegate })
    } catch { self.postMessage({ type: 'error', message: 'Hand tracking could not start. Close the camera and try again.' }) }
    return
  }
  if (!m.frame) return
  const began = performance.now()
  try {
    if (!tracker) return
    let result
    try { result = tracker.detectForVideo(m.frame, m.at) }
    catch (e) {
      if (delegate === 'CPU') throw e
      tracker.close(); delegate = 'CPU'; tracker = await create('CPU')
      result = tracker.detectForVideo(m.frame, m.at)
    }
    self.postMessage({ type: 'result', result, at: m.at, capture: m.capture, elapsed: performance.now() - began, delegate })
  } catch { self.postMessage({ type: 'error', message: 'Hand tracking stopped. Close the camera and try again.' }) }
  finally { m.frame.close() }
}
