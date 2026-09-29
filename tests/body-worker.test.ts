import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import { bodyResult } from './body-fixture'
vi.mock('@mediapipe/tasks-vision', () => ({ FilesetResolver: { forVisionTasks: vi.fn() }, PoseLandmarker: { createFromOptions: vi.fn() }, HandLandmarker: { createFromOptions: vi.fn() } }))
vi.mock('../src/controller/body-assets', () => ({ BODY_MODEL: '/models/pose_landmarker_lite.task', bodyLoader: (p: string) => p.replace('/models/', '/models/vision-1.0.1/'), cacheBodyAsset: vi.fn(async () => new Response(new Uint8Array([1]))) }))
vi.mock('../src/controller/hand-assets', () => ({ cacheHandAsset: vi.fn(async () => new Response(new Uint8Array([1]))) }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
async function worker() {
  vi.resetModules()
  const scope = { fetch: vi.fn(), location: { href: 'https://test.example/assets/body.js', origin: 'https://test.example' }, postMessage: vi.fn(), onmessage: null as null | ((e: { data: Record<string, unknown> }) => Promise<void>) }
  vi.stubGlobal('self', scope)
  const vision = await import('@mediapipe/tasks-vision')
  vi.mocked(vision.FilesetResolver.forVisionTasks).mockResolvedValue({ wasmLoaderPath: '/models/vision_wasm_internal.js', wasmBinaryPath: '/models/vision_wasm_internal.wasm' })
  const create = vi.mocked(vision.PoseLandmarker.createFromOptions), fingers = vi.mocked(vision.HandLandmarker.createFromOptions)
  create.mockReset(); fingers.mockReset()
  await import('../src/controller/body-worker')
  const send = (data: Record<string, unknown>) => scope.onmessage!({ data })
  return { scope, create, fingers, send }
}
describe('body worker resources', () => {
  it('falls back to CPU with an in-memory Lite asset and never loads hands by default', async () => {
    const w = await worker(), cpu = { detectForVideo: vi.fn(), close: vi.fn() }
    w.create.mockRejectedValueOnce(new Error('No GPU')).mockResolvedValueOnce(cpu as unknown as PoseLandmarker)
    await w.send({ type: 'start' })
    expect(w.create.mock.calls.map(c => c[1].baseOptions?.delegate)).toEqual(['GPU', 'CPU'])
    expect(w.create.mock.calls.every(c => c[1].numPoses === 1 && c[1].outputSegmentationMasks === false && c[1].baseOptions?.modelAssetBuffer instanceof Uint8Array)).toBe(true)
    expect(w.fingers).not.toHaveBeenCalled()
    expect(w.scope.postMessage).toHaveBeenLastCalledWith({ type: 'ready', delegate: 'CPU' })
  })
  it('recovers a GPU frame on CPU, closes results and bitmaps, and reports a fatal CPU failure', async () => {
    const w = await worker(), result = { ...bodyResult(), close: vi.fn() }
    const gpu = { detectForVideo: vi.fn(() => { throw Error('GPU lost') }), close: vi.fn() }
    const cpu = { detectForVideo: vi.fn(() => result), close: vi.fn() }
    w.create.mockResolvedValueOnce(gpu as unknown as PoseLandmarker).mockResolvedValueOnce(cpu as unknown as PoseLandmarker)
    await w.send({ type: 'start' })
    const frame = { close: vi.fn() }
    await w.send({ type: 'frame', frame, at: 100, capture: 90 })
    expect(frame.close).toHaveBeenCalledOnce(); expect(result.close).toHaveBeenCalledOnce(); expect(gpu.close).toHaveBeenCalledOnce()
    expect(w.scope.postMessage.mock.calls.some(c => c[0].type === 'hands-error')).toBe(false)
    expect(w.scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'result', delegate: 'CPU', at: 100, capture: 90 }))
    cpu.detectForVideo.mockImplementationOnce(() => { throw Error('CPU failed') })
    await w.send({ type: 'frame', frame, at: 134, capture: 124 })
    expect(w.scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }))
    expect(frame.close).toHaveBeenCalledTimes(2)
  })
  it('disabling fingers while initialization is pending closes the late hand model', async () => {
    const w = await worker()
    w.create.mockResolvedValueOnce({ close: vi.fn() } as unknown as PoseLandmarker)
    await w.send({ type: 'start' })
    let resolve!: (model: HandLandmarker) => void
    w.fingers.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const pending = w.send({ type: 'hands', hands: true })
    await vi.waitFor(() => expect(w.fingers).toHaveBeenCalledOnce())
    await w.send({ type: 'hands', hands: false })
    const late = { close: vi.fn() }; resolve(late as unknown as HandLandmarker); await pending
    expect(late.close).toHaveBeenCalledOnce()
  })
})
