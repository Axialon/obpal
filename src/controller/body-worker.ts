/** Pose Lite inference is local. Optional fingers are loaded only after an explicit enable. */
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import { BODY_MODEL, bodyLoader, cacheBodyAsset } from './body-assets'
import { cacheHandAsset } from './hand-assets'

let pose: PoseLandmarker | null = null, hand: HandLandmarker | null = null
let files: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>
let model: Uint8Array
let delegate: 'GPU' | 'CPU' = 'GPU'
let handRequest = 0
let handWanted = false
async function create(using: 'GPU' | 'CPU') {
  return PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetBuffer: model, delegate: using }, runningMode: 'VIDEO', numPoses: 1,
    outputSegmentationMasks: false, minPoseDetectionConfidence: .7, minPosePresenceConfidence: .7, minTrackingConfidence: .6,
  })
}

self.onmessage = async (event: MessageEvent<{ type: 'start' | 'frame' | 'hands'; frame?: ImageBitmap; at: number; capture: number; hands?: boolean }>) => {
  const m = event.data
  if (m.type === 'start') {
    try {
      files = await FilesetResolver.forVisionTasks('/models')
      files.wasmLoaderPath = bodyLoader(files.wasmLoaderPath)
      let bytes = 0
      const progress = (n: number) => { bytes += n; self.postMessage({ type: 'progress', value: Math.min(.99, bytes / 18_000_000) }) }
      const [asset, binary] = await Promise.all([
        cacheBodyAsset(BODY_MODEL, progress), cacheBodyAsset(files.wasmBinaryPath, progress), cacheBodyAsset(files.wasmLoaderPath, progress),
      ])
      model = new Uint8Array(await asset.arrayBuffer())
      const nativeFetch = self.fetch.bind(self)
      self.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, self.location.href)
        return url.origin === self.location.origin && url.pathname === files.wasmBinaryPath ? Promise.resolve(binary.clone()) : nativeFetch(input, init)
      }) as typeof fetch
      try { pose = await create('GPU') } catch { delegate = 'CPU'; pose = await create('CPU') }
      self.postMessage({ type: 'ready', delegate })
    } catch { self.postMessage({ type: 'error', message: 'Body tracking could not start. Close the camera and try again.' }) }
    return
  }
  if (m.type === 'hands') {
    const request = ++handRequest
    handWanted = !!m.hands
    hand?.close(); hand = null
    if (!m.hands || !pose) return
    try {
      const asset = await cacheHandAsset('/models/hand_landmarker.task')
      const tracker = await HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetBuffer: new Uint8Array(await asset.arrayBuffer()), delegate },
        runningMode: 'VIDEO', numHands: 1, minHandDetectionConfidence: .7, minHandPresenceConfidence: .7, minTrackingConfidence: .6,
      })
      if (request !== handRequest) tracker.close()
      else hand = tracker
    } catch { if (request === handRequest) self.postMessage({ type: 'hands-error', message: 'Fingers are unavailable. Body tracking stays on.' }) }
    return
  }
  if (!m.frame) return
  const began = performance.now()
  try {
    if (!pose) return
    let result
    try { result = pose.detectForVideo(m.frame, m.at) }
    catch (e) {
      if (delegate === 'CPU') throw e
      pose.close(); delegate = 'CPU'; pose = await create('CPU')
      hand?.close(); hand = null; ++handRequest
      if (handWanted) self.postMessage({ type: 'hands-error', message: 'Fingers paused while body tracking recovers.' })
      handWanted = false
      result = pose.detectForVideo(m.frame, m.at)
    }
    let fingers
    if (hand && m.hands) {
      try { fingers = hand.detectForVideo(m.frame, m.at) }
      catch { hand.close(); hand = null; self.postMessage({ type: 'hands-error', message: 'Fingers stopped. Body tracking stays on.' }) }
    }
    self.postMessage({ type: 'result', result: { landmarks: result.landmarks, worldLandmarks: result.worldLandmarks }, hand: fingers, at: m.at, capture: m.capture, elapsed: performance.now() - began, delegate })
    result.close()
  } catch { self.postMessage({ type: 'error', message: 'Body tracking stopped. Close the camera and try again.' }) }
  finally { m.frame.close() }
}
