import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeBody, decodeHand, type BodyState } from '@obpal/core'
import { BodyTracker } from '../src/controller/body-tracker'
import { cameraWorker } from '../src/ui/camera-worker'
import { bodyResult } from './body-fixture'
vi.mock('../src/ui/camera-worker', () => ({ cameraWorker: vi.fn() }))

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  receive(data: unknown) { this.onmessage?.({ data } as MessageEvent) }
  frames() { return this.postMessage.mock.calls.map(c => c[0]).filter(m => m.type === 'frame') }
}
let now = 0, workers: FakeWorker[] = []
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
function camera() {
  let seq = 0, gen = 0, callback: VideoFrameRequestCallback | null = null
  const context = Object.fromEntries(['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke'].map(k => [k, vi.fn()]))
  const video = {
    readyState: 2, videoWidth: 640, videoHeight: 480, dataset: { mirrored: 'false' },
    requestVideoFrameCallback: (fn: VideoFrameRequestCallback) => { callback = fn; return 1 },
    cancelVideoFrameCallback: vi.fn(() => { callback = null }),
  }
  const packets: BodyState[] = [], hands: ReturnType<typeof decodeHand>[] = []
  const error = vi.fn(), fingersOff = vi.fn()
  const tracker = new BodyTracker(video as unknown as HTMLVideoElement, { getContext: () => context } as unknown as HTMLCanvasElement, {
    timeOrigin: 0, sequence: () => ++seq, generation: () => ++gen,
    send: p => { packets.push(decodeBody(p)!); return true }, say: vi.fn(), error, fingersOff,
    hand: { sequence: () => ++seq, generation: () => ++gen, send: p => { hands.push(decodeHand(p)); return true } },
  })
  tracker.start()
  const worker = workers.at(-1)!
  const ready = () => worker.receive({ type: 'ready', delegate: 'GPU' })
  const present = async (at: number) => { now = at; callback?.(at, { captureTime: at } as VideoFrameCallbackMetadata); await flush() }
  const reply = (at: number) => worker.receive({ type: 'result', at, capture: at, elapsed: 2, delegate: 'GPU', result: bodyResult() })
  return { tracker, worker, ready, present, reply, packets, hands, video, error, fingersOff }
}
beforeEach(() => {
  now = 0; workers = []
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.mocked(cameraWorker).mockImplementation(() => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker })
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })))
  vi.stubGlobal('cancelAnimationFrame', vi.fn()); vi.stubGlobal('getComputedStyle', () => ({ color: '#fff' }))
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('body camera timing and lifetime', () => {
  it('waits for readiness and permits one inference, with no queued frames', async () => {
    const c = camera()
    await c.present(1); expect(createImageBitmap).not.toHaveBeenCalled()
    c.ready(); await c.present(34); await c.present(68); await c.present(102)
    expect(c.worker.frames()).toHaveLength(1)
    c.reply(999); expect(c.packets).toHaveLength(0)
    c.reply(34); await c.present(136)
    expect(c.worker.frames()).toHaveLength(2)
    expect(c.worker.frames()[1].at).toBe(136)
    c.tracker.stop()
  })
  it('rejects stale inference and waits for reacquisition', async () => {
    const c = camera(); c.ready(); await c.present(0)
    now = 250; c.reply(0)
    expect(c.packets).toHaveLength(0); expect(c.tracker.stats.dropped).toBe(1)
    for (const t of [284, 318, 352]) { await c.present(t); c.reply(t) }
    expect(c.packets.map(p => p.flags)).toEqual([0, 0, 1])
    c.tracker.stop()
  })
  it('closes a pending bitmap, terminates and ignores late replies after stop or restart', async () => {
    let resolve!: (b: ImageBitmap) => void
    vi.mocked(createImageBitmap).mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const c = camera(); c.ready(); await c.present(1); c.tracker.stop()
    expect(c.worker.terminate).toHaveBeenCalledOnce(); expect(c.packets.at(-1)?.flags).toBe(0)
    const bitmap = { close: vi.fn() }; resolve(bitmap as unknown as ImageBitmap); await flush()
    expect(bitmap.close).toHaveBeenCalledOnce(); expect(c.worker.frames()).toHaveLength(0)
    const count = c.packets.length; c.reply(1); expect(c.packets).toHaveLength(count)
    c.tracker.start(); const next = workers.at(-1)!
    next.receive({ type: 'ready', delegate: 'CPU' }); await c.present(2)
    expect(next.frames()).toHaveLength(1); c.reply(1); expect(c.packets).toHaveLength(count)
    c.tracker.stop()
  })
  it('sends BODY only by default, keeps preview mirror off the wire, and clears fingers on disable', async () => {
    const c = camera(); c.ready(); c.video.dataset.mirrored = 'true'
    const hand = {
      worldLandmarks: [Array.from({ length: 21 }, (_, i) => ({ x: i * .002, y: .02, z: 0, visibility: 1 }))],
      landmarks: [Array.from({ length: 21 }, (_, i) => ({ x: .4 + i * .003, y: .4, z: 0, visibility: 1 }))],
      handedness: [[{ categoryName: 'Left', score: .9, index: 0, displayName: '' }]], handednesses: [],
    }
    c.tracker.injectForTest(bodyResult(), hand)
    for (const t of [1, 35, 69]) await c.present(t)
    expect(c.packets.at(-1)?.landmarks[11][0]).toBe(-.2); expect(c.hands).toHaveLength(0)
    expect(c.worker.postMessage.mock.calls.some(c => c[0].type === 'hands')).toBe(false)
    c.tracker.setFingers(true); await c.present(103)
    expect(c.hands.at(-1)).toMatchObject({ flags: 1, handedness: 'left', gestures: 0, t: 103000 })
    expect(c.packets.at(-1)?.t).toBe(c.hands.at(-1)?.t)
    c.tracker.setFingers(false); expect(c.hands.at(-1)?.flags).toBe(0)
    const count = c.hands.length; await c.present(137); expect(c.hands).toHaveLength(count)
    c.tracker.stop()
  })
  it('releases on worker failure without accepting another result', async () => {
    const c = camera(); c.ready(); await c.present(1); c.worker.onerror?.()
    expect(c.error).toHaveBeenCalledOnce(); expect(c.worker.terminate).toHaveBeenCalledOnce()
    const count = c.packets.length; c.reply(1); expect(c.packets).toHaveLength(count)
  })
  it('turns an out-of-range derived palm into loss without interrupting BODY', async () => {
    const c = camera(); c.ready(); c.video.videoWidth = 720; c.video.videoHeight = 1280
    c.tracker.setFingers(true)
    const points = Array.from({ length: 21 }, () => ({ x: .5, y: -4, z: 0, visibility: 1 }))
    c.tracker.injectForTest(bodyResult(), { landmarks: [points], worldLandmarks: [points], handedness: [[{ categoryName: 'Left', score: 1, displayName: '', index: 0 }]], handednesses: [] })
    for (const t of [0, 34, 68]) await c.present(t)
    expect(c.hands.at(-1)).toMatchObject({ flags: 0, confidence: 0, handedness: 'unknown', p: [0, 0, 0] })
    expect(c.packets.at(-1)?.flags).toBe(1)
    c.tracker.stop()
  })
})
