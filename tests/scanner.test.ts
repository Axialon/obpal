import { afterEach, describe, expect, it, vi } from 'vitest'
import { Scanner } from '../src/controller/scanner'

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
function camera() {
  const track = { stop: vi.fn(), getCapabilities: () => ({ torch: true }), applyConstraints: vi.fn(async () => {}) }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
  const video = { muted: false, playsInline: false, autoplay: false, srcObject: null, readyState: 2, play: vi.fn(async () => {}), pause: vi.fn() } as unknown as HTMLVideoElement
  const torch = { hidden: false, setAttribute: vi.fn(), onclick: () => {} } as unknown as HTMLButtonElement
  const say = vi.fn(), found = vi.fn()
  return { track, stream, video, torch, say, found, scanner: new Scanner(video, torch, say, found) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

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
  it('denial leaves no camera or timer and offers the code alternative', async () => {
    const c = camera()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw new DOMException('Denied', 'NotAllowedError') } } })
    await c.scanner.start()
    expect(c.video.srcObject).toBeNull()
    expect(c.torch.hidden).toBe(true)
    expect(c.say).toHaveBeenLastCalledWith(expect.stringContaining('enter a code'))
  })
})
