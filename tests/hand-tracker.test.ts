import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeHand, HAND_BYTES, HandFlag, type HandState } from '@obpal/core'
import type { HandLandmarker, HandLandmarkerResult } from '@mediapipe/tasks-vision'
import { HandTracker, type HandMetrics } from '../src/controller/hand-tracker'
import { HandBandwidth } from '../src/controller/hand-signal'
import { cameraWorker } from '../src/ui/camera-worker'

vi.mock('../src/ui/camera-worker', () => ({ cameraWorker: vi.fn() }))
vi.mock('../src/controller/hand-assets', () => ({ cacheHandAsset: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) }))
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: vi.fn() },
  HandLandmarker: { createFromOptions: vi.fn() },
}))

type FrameMessage = { type: 'frame'; frame: ImageBitmap; at: number; capture: number }
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  postMessage = vi.fn<(message: { type: string }, transfer?: Transferable[]) => void>()
  terminate = vi.fn()
  receive(data: unknown) { this.onmessage?.({ data } as MessageEvent) }
  frames() { return this.postMessage.mock.calls.map(c => c[0]).filter(m => m.type === 'frame') as FrameMessage[] }
}

let now = 0
let workers: FakeWorker[] = []
let animations = new Map<number, FrameRequestCallback>()

const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const bitmap = () => ({ close: vi.fn() } as unknown as ImageBitmap)

function result(handedness = 'Left'): HandLandmarkerResult {
  const worldLandmarks = Array.from({ length: 21 }, (_, i) => ({ x: (i % 5 - 2) * .015, y: -Math.floor(i / 5) * .018, z: (i - 10) * .001, visibility: 1 }))
  const landmarks = worldLandmarks.map(p => ({ x: .5 + p.x * 2, y: .5 + p.y * 2, z: p.z, visibility: 1 }))
  const labels = [[{ categoryName: handedness, displayName: '', score: .9, index: 0 }]]
  return { worldLandmarks: [worldLandmarks], landmarks: [landmarks], handedness: labels, handednesses: labels }
}

function camera(o: { counters?: { seq: number; gen: number }; timeOrigin?: number; frameCallback?: boolean } = {}) {
  const counters = o.counters ?? { seq: 0, gen: 0 }
  const callbacks = new Map<number, VideoFrameRequestCallback>()
  let nextCallback = 0, presented = 0
  const track = { applyConstraints: vi.fn().mockResolvedValue(undefined) }
  const video = {
    dataset: { mirrored: 'false' },
    videoWidth: 640, videoHeight: 480, readyState: 2, currentTime: 0,
    srcObject: { getVideoTracks: () => [track] },
    requestVideoFrameCallback: o.frameCallback === false ? undefined : vi.fn((callback: VideoFrameRequestCallback) => {
      callbacks.set(++nextCallback, callback); return nextCallback
    }),
    cancelVideoFrameCallback: vi.fn((id: number) => callbacks.delete(id)),
  }
  const context = {
    setTransform: vi.fn(), closePath: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
  }
  const overlay = { width: 0, height: 0, getContext: () => context }
  const packets: HandState[] = [], measurements: HandMetrics[] = []
  const send = vi.fn((packet: ArrayBuffer) => { packets.push(decodeHand(packet)!); return true })
  const say = vi.fn()
  const tracker = new HandTracker(video as unknown as HTMLVideoElement, overlay as unknown as HTMLCanvasElement, {
    sequence: () => (counters.seq = (counters.seq + 1) & 0xffff),
    generation: () => (counters.gen = (counters.gen + 1) & 0xff),
    timeOrigin: o.timeOrigin ?? 0, send, say, metrics: value => measurements.push(value),
  })
  tracker.start()
  const worker = workers.at(-1)!
  const ready = () => worker.receive({ type: 'ready', delegate: 'GPU' })
  const present = (at: number, capture: number | null = at, presentation = at, frames = ++presented) => {
    now = at; video.currentTime = at / 1000
    const next = callbacks.entries().next().value
    if (!next) throw new Error('No camera frame requested')
    callbacks.delete(next[0])
    next[1](at, { presentedFrames: frames, presentationTime: presentation, ...(capture === null ? {} : { captureTime: capture }) } as VideoFrameCallbackMetadata)
  }
  const deliver = async (value: HandLandmarkerResult, at: number, capture = at, elapsed = 2) => {
    present(at, capture)
    await flush()
    const frame = worker.frames().at(-1)!
    worker.receive({ type: 'result', result: value, at: frame.at, capture: frame.capture, elapsed, delegate: 'GPU' })
  }
  return { tracker, worker, video, overlay, context, callbacks, ready, present, deliver, packets, measurements, track, send, say }
}

beforeEach(() => {
  now = 0; workers = []; animations = new Map()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.mocked(cameraWorker).mockImplementation(() => {
    const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker
  })
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap()))
  let animation = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { animations.set(++animation, callback); return animation }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => animations.delete(id)))
  vi.stubGlobal('getComputedStyle', () => ({ color: '#fff' }))
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('camera hand tracking lifetime', () => {
  it('warns about fingertips cropped by the visible cover frame even inside the source image', async () => {
    const c = camera(); c.ready()
    Object.assign(c.overlay, { clientWidth: 390, clientHeight: 844 })
    const hand = result()
    await c.deliver(hand, 100)
    expect(c.say).not.toHaveBeenLastCalledWith('Farther')
    hand.landmarks[0][4].x = .72
    await c.deliver(hand, 120)
    expect(c.say).toHaveBeenLastCalledWith('Farther')
    c.tracker.stop()
  })

  it('front capture negates x and swaps handedness in the actual HAND packet', async () => {
    const rear = camera(); rear.ready(); await rear.deliver(result('Left'), 100)
    const a = rear.packets.at(-1)!
    rear.tracker.stop()
    const front = camera(); front.video.dataset.mirrored = 'true'; front.ready(); await front.deliver(result('Left'), 200)
    const b = front.packets.at(-1)!
    expect(a.handedness).toBe('left'); expect(b.handedness).toBe('right')
    expect(b.p[0]).toBeCloseTo(-a.p[0], 3)
    expect(b.landmarks.map(p => p[0])).toEqual(a.landmarks.map(p => -p[0] || 0))
    front.tracker.stop()
  })
  it('waits for model readiness and keeps only one inference frame in flight', async () => {
    const c = camera()
    expect(c.worker.postMessage).toHaveBeenCalledWith({ type: 'start' })
    c.present(10); await flush()
    expect(createImageBitmap).not.toHaveBeenCalled()
    c.ready()
    c.present(20); await flush()
    expect(c.worker.frames()).toHaveLength(1)
    const first = c.worker.frames()[0]
    expect(c.worker.postMessage).toHaveBeenLastCalledWith(first, [first.frame])
    c.present(30); c.present(40); await flush()
    expect(createImageBitmap).toHaveBeenCalledTimes(1)
    expect(c.worker.frames()).toHaveLength(1)
    c.worker.receive({ type: 'result', result: result(), at: first.at, capture: first.capture, elapsed: 20, delegate: 'GPU' })
    c.present(50); await flush()
    expect(c.worker.frames()).toHaveLength(2)
    expect(c.worker.frames()[1].at).toBe(50)
    c.tracker.stop()
  })

  it('keeps injected sequence and generation counters across fresh camera sessions and wire wrap', async () => {
    const counters = { seq: 65534, gen: 253 }, first = camera({ counters })
    first.ready(); await first.deliver(result(), 10)
    const origin = first.packets[0].gen
    now = 20; first.tracker.stop()
    const second = camera({ counters })
    second.ready(); await second.deliver(result(), 30)
    expect([...first.packets, ...second.packets].map(p => p.seq)).toEqual([65535, 0, 1])
    expect(first.packets.at(-1)).toMatchObject({ flags: 0, gestures: 0, handedness: 'unknown' })
    expect(second.packets[0].gen).not.toBe(origin)
    second.tracker.stop()
  })

  it('releases immediately on stop, closes a late bitmap, and ignores queued worker results', async () => {
    let resolve!: (frame: ImageBitmap) => void
    vi.mocked(createImageBitmap).mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const c = camera(), late = bitmap()
    c.ready(); c.present(10)
    c.tracker.stop()
    const sent = c.send.mock.calls.length
    expect(c.worker.terminate).toHaveBeenCalledTimes(1)
    expect(c.callbacks.size).toBe(0)
    expect(c.packets.at(-1)).toMatchObject({ flags: 0, gestures: 0 })
    resolve(late); await flush()
    expect(late.close).toHaveBeenCalledTimes(1)
    expect(c.worker.frames()).toHaveLength(0)
    c.worker.receive({ type: 'ready', delegate: 'CPU' })
    c.worker.receive({ type: 'result', result: result(), at: 10, capture: 10, elapsed: 1, delegate: 'CPU' })
    c.tracker.stop()
    expect(c.send).toHaveBeenCalledTimes(sent)
    expect(c.worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('can restart the same tracker while an old bitmap or worker result is pending', async () => {
    let resolve!: (frame: ImageBitmap) => void
    vi.mocked(createImageBitmap).mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const c = camera(), late = bitmap(), old = c.worker
    c.ready(); c.present(10); c.tracker.stop()
    c.tracker.start()
    const fresh = workers.at(-1)!
    fresh.receive({ type: 'ready', delegate: 'GPU' })
    resolve(late); await flush()
    old.receive({ type: 'result', result: result('Right'), at: 10, capture: 10, elapsed: 1, delegate: 'CPU' })
    expect(late.close).toHaveBeenCalledTimes(1)
    expect(fresh.frames()).toHaveLength(0)
    expect(c.packets.every(p => p.flags === 0)).toBe(true)
    c.present(30); await flush()
    expect(fresh.frames()).toHaveLength(1)
    const frame = fresh.frames()[0]
    fresh.receive({ type: 'result', result: result(), at: frame.at, capture: frame.capture, elapsed: 1, delegate: 'GPU' })
    expect(c.packets.at(-1)?.flags).toBe(HandFlag.tracked)
    c.tracker.stop()
  })

  it('recovers from a rejected bitmap without leaving inference busy', async () => {
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('Camera frame expired'))
    const c = camera()
    c.ready(); c.present(10); await flush()
    expect(c.worker.frames()).toHaveLength(0)
    await c.deliver(result(), 30)
    expect(c.packets.at(-1)?.flags).toBe(HandFlag.tracked)
    c.tracker.stop()
  })

  it('closes an untransferred bitmap if posting to the worker fails', async () => {
    const c = camera(), frame = bitmap()
    vi.mocked(createImageBitmap).mockResolvedValueOnce(frame)
    c.ready()
    c.worker.postMessage.mockImplementationOnce(() => { throw new Error('Transfer failed') })
    c.present(10); await flush()
    expect(frame.close).toHaveBeenCalledTimes(1)
    await c.deliver(result(), 30)
    expect(c.packets.at(-1)?.flags).toBe(HandFlag.tracked)
    c.tracker.stop()
  })

  it('stops and emits loss on worker failure', async () => {
    const c = camera()
    c.ready(); await c.deliver(result(), 10)
    c.worker.receive({ type: 'error', message: 'Model unavailable' })
    expect(c.packets.at(-1)).toMatchObject({ flags: 0, gestures: 0 })
    expect(c.say).toHaveBeenLastCalledWith('Model unavailable')
    expect(c.worker.terminate).toHaveBeenCalledTimes(1)
    expect(c.callbacks.size).toBe(0)
  })
})

describe('camera hand results and clocks', () => {
  it('uses capture time on the wire and converts model axes before quantization', async () => {
    const c = camera({ timeOrigin: 50 }), output = result()
    c.ready(); await c.deliver(output, 100, 83)
    const packet = c.packets[0]
    expect(packet.t).toBe(33000)
    expect(c.tracker.stats.clock).toBe('capture')
    expect(packet.handedness).toBe('left')
    expect(packet.confidence).toBeCloseTo(.9, 2)
    for (const [i, p] of output.worldLandmarks[0].entries()) {
      for (const [axis, value] of [p.x, -p.y, -p.z].entries()) {
        expect(Math.abs(packet.landmarks[i][axis] - value)).toBeLessThanOrEqual(.00025 + 1e-12)
      }
    }
    expect(packet.p.every(Number.isFinite)).toBe(true)
    expect(packet.p[2]).toBeLessThan(0)
    const lost = result(); lost.worldLandmarks = []
    await c.deliver(lost, 130, 113)
    expect(c.packets.at(-1)).toMatchObject({ flags: 0, t: 63000 })
    c.tracker.stop()
  })

  it('uses presentation time when capture metadata is absent', async () => {
    const c = camera()
    c.ready(); c.present(100, null, 90); await flush()
    const frame = c.worker.frames()[0]
    c.worker.receive({ type: 'result', result: result(), at: frame.at, capture: frame.capture, elapsed: 2, delegate: 'GPU' })
    expect(c.packets[0].t).toBe(90000)
    expect(c.tracker.stats.clock).toBe('presentation')
    c.tracker.stop()
  })

  it.each([
    ['no hand', (r: HandLandmarkerResult) => { r.worldLandmarks = [] }],
    ['too few landmarks', (r: HandLandmarkerResult) => { r.landmarks[0].pop() }],
    ['low confidence', (r: HandLandmarkerResult) => { r.handedness[0][0].score = .59 }],
    ['confidence above one', (r: HandLandmarkerResult) => { r.handedness[0][0].score = 1.01 }],
    ['non-finite world point', (r: HandLandmarkerResult) => { r.worldLandmarks[0][3].x = NaN }],
    ['world point beyond the wire range', (r: HandLandmarkerResult) => { r.worldLandmarks[0][3].x = 20 }],
    ['non-finite image point', (r: HandLandmarkerResult) => { r.landmarks[0][3].z = Infinity }],
    ['invalid palm translation', (r: HandLandmarkerResult) => { for (const p of r.landmarks[0]) p.x += 1000 }],
    ['sparse landmarks', (r: HandLandmarkerResult) => { delete r.worldLandmarks[0][3] }],
    ['missing collections', (r: HandLandmarkerResult) => { delete (r as Partial<HandLandmarkerResult>).worldLandmarks }],
  ] as const)('emits loss for %s and gives reacquisition a fresh generation', async (_, invalidate) => {
    const c = camera()
    c.ready(); await c.deliver(result(), 10)
    const generation = c.packets[0].gen, invalid = result()
    invalidate(invalid)
    await c.deliver(invalid, 30)
    expect(c.packets.at(-1)).toMatchObject({ flags: 0, gestures: 0, confidence: 0, handedness: 'unknown' })
    await c.deliver(result(), 50)
    expect(c.packets.at(-1)?.flags).toBe(HandFlag.tracked)
    expect(c.packets.at(-1)?.gen).not.toBe(generation)
    c.tracker.stop()
  })

  it('changes identity on handedness and reinitializes landmark filters', async () => {
    const c = camera()
    c.ready(); await c.deliver(result(), 10)
    const first = c.packets[0], switched = result('Right')
    switched.worldLandmarks[0][8].x += .1
    await c.deliver(switched, 30)
    const next = c.packets[1]
    expect(next.gen).not.toBe(first.gen)
    expect(next.handedness).toBe('right')
    expect(next.landmarks[8][0]).toBeCloseTo(switched.worldLandmarks[0][8].x, 4)
    c.tracker.stop()
  })

  it('treats an out-of-range derived palm as lost even when its input coordinates are finite', async () => {
    const c = camera(), output = result()
    c.video.videoWidth = 720; c.video.videoHeight = 1280
    for (const p of output.landmarks[0]) { p.x = .5; p.y = -4 }
    c.ready(); await c.deliver(output, 10)
    expect(c.packets.at(-1)).toMatchObject({ flags: 0, gestures: 0 })
    await c.deliver(result(), 30)
    expect(c.packets.at(-1)?.flags).toBe(HandFlag.tracked)
    c.tracker.stop()
  })

  it('falls back to animation frames but infers once per changed video frame', async () => {
    const c = camera({ frameCallback: false })
    c.ready()
    const animate = async (at: number, currentTime: number) => {
      now = at; c.video.currentTime = currentTime
      const next = animations.entries().next().value!
      animations.delete(next[0]); next[1](at)
      await flush()
    }
    await animate(10, .01)
    const first = c.worker.frames()[0]
    c.worker.receive({ type: 'result', result: result(), at: first.at, capture: first.capture, elapsed: 2, delegate: 'GPU' })
    await animate(20, .01)
    expect(c.worker.frames()).toHaveLength(1)
    await animate(30, .03)
    expect(c.worker.frames()).toHaveLength(2)
    c.tracker.stop()
    expect(animations.size).toBe(0)
  })

  it('includes the send call itself in capture-to-send latency', async () => {
    const c = camera()
    c.send.mockImplementation(() => { now += 5; return true })
    c.ready(); await c.deliver(result(), 1000, 990)
    expect(c.measurements[0].latencyMs).toBe(15)
    c.tracker.stop()
  })

  it('reports presented, inferred and sent cadence separately with capture-to-send latency', async () => {
    const c = camera()
    c.ready()
    let attempts = 0
    c.send.mockImplementation(packet => {
      if (attempts++ % 2) return false
      c.packets.push(decodeHand(packet)!); return true
    })
    for (let i = 1; i <= 120; i++) {
      c.present(i * 1000 / 120, i * 1000 / 120 - 5)
      await flush()
      // Inference completes every second camera frame; every second send then meets channel backpressure.
      if (i % 2 === 0) {
        const frame = c.worker.frames().at(-1)!
        c.worker.receive({ type: 'result', result: result(), at: frame.at, capture: frame.capture, elapsed: 6, delegate: 'GPU' })
      }
    }
    expect(c.measurements).toHaveLength(1)
    expect(c.measurements[0]).toMatchObject({ width: 640, height: 480, frames: 60, packets: 30, clock: 'capture' })
    expect(c.measurements[0].cameraFps).toBeCloseTo(120)
    expect(c.measurements[0].trackingFps).toBeCloseTo(60)
    expect(c.measurements[0].sentFps).toBeCloseTo(30)
    expect(c.measurements[0].bytesPerSecond).toBeCloseTo(4320)
    expect(c.measurements[0].latencyMs).toBeCloseTo(5 + 1000 / 120)
    expect(c.measurements[0].latencyP95Ms).toBeCloseTo(5 + 1000 / 120)
    expect(c.measurements[0].inferenceMs).toBeCloseTo(6)
    c.tracker.stop()
  })
})

describe('camera hand upstream budget', () => {
  it('admits sustained 125 fps while reserving 2 kB/s for companion state', () => {
    const budget = new HandBandwidth()
    let bytes = 0
    for (let at = 0; at < 10_000; at += 8) if (budget.take(at)) bytes += HAND_BYTES
    expect(bytes).toBe(180_000)
  })

  it('limits a saturated ten-second stream to 18 kB/s plus its two-packet burst', () => {
    const budget = new HandBandwidth()
    let bytes = 0
    for (let at = 0; at < 10_000; at++) if (budget.take(at)) bytes += HAND_BYTES
    expect(bytes).toBeLessThanOrEqual(180_000 + 2 * HAND_BYTES)
    expect(bytes).toBeGreaterThanOrEqual(180_000 - HAND_BYTES)
  })
})

describe('hand worker delegates', () => {
  const workerScope = async () => {
    vi.resetModules()
    const scope = { fetch: vi.fn(), location: { href: 'https://obpal.test/assets/hand-worker.js', origin: 'https://obpal.test' }, onmessage: null as null | ((event: { data: Record<string, unknown> }) => Promise<void>), postMessage: vi.fn() }
    vi.stubGlobal('self', scope)
    const vision = await import('@mediapipe/tasks-vision')
    vi.mocked(vision.FilesetResolver.forVisionTasks).mockResolvedValue({ wasmLoaderPath: '/models/vision_wasm_internal.js', wasmBinaryPath: '/models/vision_wasm_internal.wasm' })
    vi.mocked(vision.HandLandmarker.createFromOptions).mockReset()
    await import('../src/controller/hand-worker')
    return { scope, create: vi.mocked(vision.HandLandmarker.createFromOptions) }
  }

  it('falls back to local CPU initialization when GPU creation fails', async () => {
    const { scope, create } = await workerScope()
    const cpu = { detectForVideo: vi.fn(), close: vi.fn() }
    create.mockRejectedValueOnce(new Error('No GPU')).mockResolvedValueOnce(cpu as unknown as HandLandmarker)
    await scope.onmessage!({ data: { type: 'start' } })
    expect(create.mock.calls.map(c => c[1].baseOptions?.delegate)).toEqual(['GPU', 'CPU'])
    expect(create.mock.calls.every(c => c[1].baseOptions?.modelAssetBuffer instanceof Uint8Array)).toBe(true)
    expect(scope.postMessage).toHaveBeenLastCalledWith({ type: 'ready', delegate: 'CPU' })
  })

  it('retries a failed GPU frame on CPU, preserves capture time, and closes every frame', async () => {
    const { scope, create } = await workerScope(), output = result()
    const gpu = { detectForVideo: vi.fn(() => { throw new Error('GPU lost') }), close: vi.fn() }
    const cpu = { detectForVideo: vi.fn(() => output), close: vi.fn() }
    create.mockResolvedValueOnce(gpu as unknown as HandLandmarker).mockResolvedValueOnce(cpu as unknown as HandLandmarker)
    await scope.onmessage!({ data: { type: 'start' } })
    const frame = bitmap()
    await scope.onmessage!({ data: { type: 'frame', frame, at: 100, capture: 83 } })
    expect(gpu.close).toHaveBeenCalledTimes(1)
    expect(cpu.detectForVideo).toHaveBeenCalledWith(frame, 100)
    expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'result', result: output, at: 100, capture: 83, delegate: 'CPU' }))
    expect(frame.close).toHaveBeenCalledTimes(1)
    cpu.detectForVideo.mockImplementationOnce(() => { throw new Error('CPU failed') })
    const failed = bitmap()
    await scope.onmessage!({ data: { type: 'frame', frame: failed, at: 120, capture: 103 } })
    expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }))
    expect(failed.close).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(2)
  })
})
