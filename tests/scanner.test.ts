import { afterEach, describe, expect, it, vi } from 'vitest'
import { Scanner } from '../src/controller/scanner'
import { cameraWorker } from '../src/ui/camera-worker'

vi.mock('../src/ui/camera-worker', () => ({ cameraWorker: vi.fn() }))

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
function camera(options: ConstructorParameters<typeof Scanner>[4] = {}) {
  const track = { stop: vi.fn(), getCapabilities: vi.fn((): MediaTrackCapabilities & { torch: boolean } => ({ torch: true })), applyConstraints: vi.fn(async (_constraints: MediaTrackConstraints) => {}) }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
  const video = { muted: false, playsInline: false, autoplay: false, srcObject: null, readyState: 2, videoWidth: 1280, videoHeight: 720, play: vi.fn(async () => {}), pause: vi.fn() } as unknown as HTMLVideoElement
  const torch = { hidden: false, setAttribute: vi.fn(), onclick: () => {} } as unknown as HTMLButtonElement
  const say = vi.fn(), found = vi.fn()
  return { track, stream, video, torch, say, found, scanner: new Scanner(video, torch, say, found, options) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks() })

function workerFrames() {
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null } as unknown as Worker
  vi.mocked(cameraWorker).mockReturnValue(worker)
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4), width: canvas.width, height: canvas.height }) }) }
  vi.stubGlobal('document', { createElement: () => canvas })
  vi.stubGlobal('BarcodeDetector', undefined)
  return { worker, canvas }
}

describe('camera lifetime', () => {
  it('closes immediately and stops a stream whose permission arrives after close', async () => {
    const c = camera(), permission = deferred<MediaStream>()
    const getUserMedia = vi.fn((_constraints: MediaStreamConstraints) => permission.promise)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const opening = c.scanner.start()
    c.scanner.stop()
    permission.resolve(c.stream)
    await opening
    expect(c.track.stop).toHaveBeenCalledOnce()
    expect(c.video.srcObject).toBeNull()
    expect(c.video.play).not.toHaveBeenCalled()
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({ audio: false, video: { facingMode: { ideal: 'environment' } } })
  })
  it('uses native QR support, exposes a working torch, and discards decoding after close', async () => {
    vi.useFakeTimers()
    const c = camera(), reading = deferred<{ rawValue: string }[]>()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => c.stream } })
    vi.stubGlobal('BarcodeDetector', class {
      static async getSupportedFormats() { return ['qr_code'] }
      detect() { return reading.promise }
    })
    await c.scanner.start()
    expect(c.torch.hidden).toBe(false)
    c.torch.onclick!.call(c.torch, {} as PointerEvent)
    await Promise.resolve()
    expect(c.track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] })
    c.scanner.stop()
    expect(c.track.stop).toHaveBeenCalledOnce()
    reading.resolve([{ rawValue: '1234567890' }])
    await Promise.resolve()
    expect(c.found).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('hand mode uses the same stream at the camera’s available rate and never loads a QR reader', async () => {
    vi.useFakeTimers()
    const ready = vi.fn(), native = vi.fn()
    const c = camera({ scan: false, ready })
    c.track.getCapabilities.mockReturnValue({ torch: true, frameRate: { min: 1, max: 120 } })
    const getUserMedia = vi.fn(async () => c.stream)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal('BarcodeDetector', native)
    await c.scanner.start()
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ frameRate: { ideal: 60, max: 120 } }) }))
    expect(c.track.applyConstraints).toHaveBeenCalledWith({ frameRate: { ideal: 120, max: 120 } })
    expect(ready).toHaveBeenCalledWith(c.video)
    expect(native).not.toHaveBeenCalled()
    expect(cameraWorker).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    c.scanner.stop()
    expect(c.track.stop).toHaveBeenCalledOnce()
  })

  it('starts hands on the mirrored front camera and offers flipping only with multiple video inputs', async () => {
    const facing = vi.fn(), c = camera({ scan: false, facing })
    const getUserMedia = vi.fn(async () => c.stream)
    const enumerateDevices = vi.fn(async () => [{ kind: 'videoinput' }, { kind: 'audioinput' }])
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices } })
    await c.scanner.start()
    expect(getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ video: expect.objectContaining({ facingMode: { ideal: 'user' } }) }))
    expect(facing).toHaveBeenLastCalledWith(true, false)
    enumerateDevices.mockResolvedValue([{ kind: 'videoinput' }, { kind: 'videoinput' }])
    await c.scanner.flip()
    expect(getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ video: expect.objectContaining({ facingMode: { ideal: 'environment' } }) }))
    expect(facing).toHaveBeenLastCalledWith(false, true)
    expect(c.track.stop).toHaveBeenCalledOnce()
    c.scanner.stop()
  })

  it('sends one small frame to its worker at a time and discards a worker result after close', async () => {
    vi.useFakeTimers()
    const c = camera(), { worker, canvas } = workerFrames()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => c.stream } })
    await c.scanner.start()
    expect(cameraWorker).toHaveBeenCalledWith('qr')
    expect(canvas.width).toBe(720)
    expect(canvas.height).toBe(405)
    expect(worker.postMessage).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(500)
    expect(worker.postMessage).toHaveBeenCalledOnce()
    c.scanner.stop()
    expect(worker.terminate).toHaveBeenCalledOnce()
    worker.onmessage!.call(worker, { data: { id: 1, text: '1234567890' } } as MessageEvent)
    await Promise.resolve()
    expect(c.found).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a failed native decoder falls back to the worker without asking for the camera again', async () => {
    vi.useFakeTimers()
    const c = camera(), { worker } = workerFrames()
    const getUserMedia = vi.fn(async () => c.stream)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal('BarcodeDetector', class {
      static async getSupportedFormats() { return ['qr_code'] }
      async detect() { throw new Error('Unsupported frame') }
    })
    await c.scanner.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(worker.postMessage).toHaveBeenCalledOnce()
    worker.onmessage!.call(worker, { data: { id: 1, text: '1234567890' } } as MessageEvent)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.found).toHaveBeenCalledExactlyOnceWith('1234567890', undefined)
    c.scanner.stop()
  })

  it('a stalled worker is terminated and leaves the typed-code alternative reachable', async () => {
    vi.useFakeTimers()
    const c = camera(), { worker } = workerFrames()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => c.stream } })
    await c.scanner.start()
    await vi.advanceTimersByTimeAsync(2500)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(c.say).toHaveBeenLastCalledWith(expect.stringContaining('Enter the code'))
    expect(vi.getTimerCount()).toBe(0)
    c.scanner.stop()
  })

  it('reads at eight frames per second and suppresses a repeated code', async () => {
    vi.useFakeTimers()
    const c = camera(), detect = vi.fn(async () => [{ rawValue: '1234567890' }])
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => c.stream } })
    vi.stubGlobal('BarcodeDetector', class { static async getSupportedFormats() { return ['qr_code'] }; detect = detect })
    await c.scanner.start()
    await vi.advanceTimersByTimeAsync(999)
    expect(detect).toHaveBeenCalledTimes(8)
    expect(c.found).toHaveBeenCalledOnce()
    c.scanner.stop()
  })

  it('passes native decoder corners in source-normalized coordinates', async () => {
    vi.useFakeTimers()
    const c = camera()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => c.stream } })
    vi.stubGlobal('BarcodeDetector', class {
      static async getSupportedFormats() { return ['qr_code'] }
      async detect() { return [{ rawValue: '1234567890', cornerPoints: [{ x: 128, y: 72 }, { x: 256, y: 72 }, { x: 256, y: 144 }, { x: 128, y: 144 }] }] }
    })
    await c.scanner.start(); await vi.advanceTimersByTimeAsync(1)
    expect(c.found).toHaveBeenCalledExactlyOnceWith('1234567890', [{ x: .1, y: .1 }, { x: .2, y: .1 }, { x: .2, y: .2 }, { x: .1, y: .2 }])
    c.scanner.stop()
  })

  it.each([
    ['NotFoundError', '', 'No camera was found'],
    ['NotReadableError', '', 'camera is busy'],
    ['NotAllowedError', 'Instagram', 'Open this page in Safari or Chrome'],
  ])('explains %s and keeps code entry available', async (name, userAgent, message) => {
    const c = camera()
    vi.stubGlobal('navigator', { userAgent, mediaDevices: { getUserMedia: async () => { throw new DOMException('Unavailable', name) } } })
    await c.scanner.start()
    expect(c.say).toHaveBeenLastCalledWith(expect.stringContaining(message))
    expect(c.say.mock.lastCall?.[0].toLowerCase()).toContain('code')
  })

  it('does not request camera access on an insecure page', async () => {
    const c = camera(), getUserMedia = vi.fn()
    vi.stubGlobal('isSecureContext', false)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    await c.scanner.start()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(c.say).toHaveBeenLastCalledWith(expect.stringContaining('https'))
  })

  it('denial leaves no camera or timer and offers the code alternative', async () => {
    const c = camera()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw new DOMException('Denied', 'NotAllowedError') } } })
    await c.scanner.start()
    expect(c.video.srcObject).toBeNull()
    expect(c.torch.hidden).toBe(true)
    expect(c.say).toHaveBeenLastCalledWith(expect.stringContaining('enter a code'))
  })
})
