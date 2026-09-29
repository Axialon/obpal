import { cameraWorker } from '../ui/camera-worker'

type CameraState = 'opening' | 'ready' | 'unavailable'
export type CodeCorner = { x: number; y: number }
type Code = { text: string; corners?: CodeCorner[] }
type CameraOptions = {
  scan?: boolean
  zoom?: HTMLButtonElement
  ready?: (video: HTMLVideoElement) => void
  state?: (state: CameraState) => void
  facing?: (mirrored: boolean, canFlip: boolean) => void
}
type Capabilities = MediaTrackCapabilities & {
  torch?: boolean
  zoom?: { min: number; max: number; step: number }
  focusMode?: string[]
  pointsOfInterest?: unknown
}

/** One camera lifetime, shared by pairing and hand tracking. Closing also stops late permission and decoder work. */
export class Scanner {
  private stream: MediaStream | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private lit = false
  private zoomed = false
  private seen = { text: '', at: 0 }
  private worker: Worker | null = null
  private workerTimer: ReturnType<typeof setTimeout> | undefined
  private pending: ((code: Code | null) => void) | null = null
  private sequence = 0
  private decoding = false
  private front: boolean

  constructor(private video: HTMLVideoElement, private torch: HTMLButtonElement, private say: (s: string) => void, private found: (s: string, corners?: CodeCorner[]) => void, private options: CameraOptions = {}) {
    this.front = options.scan === false
    video.muted = true
    video.playsInline = true
    video.autoplay = true
    torch.hidden = true
    torch.setAttribute('aria-pressed', 'false')
    torch.onclick = () => void this.light()
    if (options.zoom) {
      options.zoom.hidden = true
      options.zoom.onclick = () => void this.zoom()
    }
    video.onclick = (e) => void this.focus(e)
  }

  /** Call directly from the opening tap: getUserMedia is requested before the first await. */
  async start() {
    this.stop()
    const generation = this.generation
    const alive = () => generation === this.generation
    this.options.state?.('opening')
    this.say('')
    if (globalThis.isSecureContext === false) {
      this.unavailable('The camera needs a secure page. Open this site with https, or enter a code.')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.unavailable('This browser cannot open the camera. Open in Safari or Chrome, or enter a code.')
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: this.options.scan === false
        ? { facingMode: { ideal: this.front ? 'user' : 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60, max: 120 } }
        : { facingMode: { ideal: this.front ? 'user' : 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
    } catch (e) {
      if (!alive()) return
      this.stop()
      const name = e instanceof Error ? e.name : ''
      const inApp = /FBAN|FBAV|Instagram|Line\/|; wv\)/i.test(navigator.userAgent ?? '')
      this.unavailable(inApp
        ? 'Open this page in Safari or Chrome to use the camera, or enter a code here.'
        : name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera access is off. Allow it in your browser, or enter a code.'
          : name === 'NotFoundError' || name === 'DevicesNotFoundError'
            ? 'No camera was found. Enter the code shown on your screen.'
            : name === 'NotReadableError'
              ? 'The camera is busy. Close other camera apps and try again, or enter a code.'
              : 'Camera unavailable. Open in Safari or Chrome, or enter a code.')
      return
    }
    if (!alive()) { stream.getTracks().forEach((t) => t.stop()); return }
    this.stream = stream
    this.video.srcObject = stream
    const facing = stream.getVideoTracks()[0]?.getSettings?.().facingMode
    if (facing) this.front = facing === 'user'
    if (this.video.dataset) this.video.dataset.mirrored = String(this.front)
    const inputs = await navigator.mediaDevices.enumerateDevices?.().catch(() => []) ?? []
    if (!alive()) return
    this.options.facing?.(this.front, inputs.filter(d => d.kind === 'videoinput').length > 1)
    const caps = this.capabilities()
    if (this.options.scan === false && caps.frameRate?.max) {
      await stream.getVideoTracks()[0]?.applyConstraints({ frameRate: { ideal: Math.min(120, caps.frameRate.max), max: 120 } }).catch(() => {})
      if (!alive()) return
    }
    this.torch.hidden = !caps.torch
    if (this.options.zoom) this.options.zoom.hidden = !(caps.zoom && caps.zoom.max > caps.zoom.min)
    const playing = await this.video.play().then(() => true, () => false)
    if (!alive()) return
    this.options.state?.('ready')
    this.say(playing ? (this.options.scan === false ? 'Show your hand' : 'Scan a screen’s code') : 'Tap the picture to start the camera')
    this.options.ready?.(this.video)
    if (this.options.scan === false || !alive()) return
    this.decoding = true
    const decode = await this.decoder(alive)
    const scan = async () => {
      if (!alive() || !this.decoding) return
      const at = performance.now()
      try {
        if (this.video.readyState >= 2) {
          const code = await decode(this.video)
          if (!alive()) return
          if (code && (code.text !== this.seen.text || Date.now() - this.seen.at > 2000)) {
            this.seen = { text: code.text, at: Date.now() }
            this.found(code.text, code.corners)
          }
        }
      } catch { /* a frame can arrive while the picture is resizing */ }
      if (alive() && this.decoding) this.timer = setTimeout(() => void scan(), Math.max(0, 125 - (performance.now() - at)))
    }
    void scan()
  }

  flip() { this.front = !this.front; return this.start() }

  stop() {
    ++this.generation
    clearTimeout(this.timer)
    this.timer = undefined
    this.decoding = false
    this.releaseWorker()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.pause()
    this.video.srcObject = null
    this.lit = false
    this.zoomed = false
    this.seen = { text: '', at: 0 }
    this.torch.hidden = true
    this.torch.setAttribute('aria-pressed', 'false')
    if (this.options.zoom) { this.options.zoom.hidden = true; this.options.zoom.textContent = '1×' }
  }

  private unavailable(text: string) {
    this.options.state?.('unavailable')
    this.say(this.options.scan === false ? text.replace(/([Ee])nter (?:the code shown on your screen|a code(?: here)?)/g, (_, first: string) => `${first === 'E' ? 'U' : 'u'}se phone motion`) : text)
  }
  private capabilities(): Capabilities { return this.stream?.getVideoTracks()[0]?.getCapabilities?.() ?? {} }

  private async light() {
    const track = this.stream?.getVideoTracks()[0]
    if (!track) return
    try {
      const lit = !this.lit
      await track.applyConstraints({ advanced: [{ torch: lit } as MediaTrackConstraintSet] })
      if (this.stream?.getVideoTracks()[0] !== track) return
      this.lit = lit
      this.torch.setAttribute('aria-pressed', String(lit))
    } catch { if (this.stream?.getVideoTracks()[0] === track) this.say('This camera could not change the torch.') }
  }

  private async zoom() {
    const track = this.stream?.getVideoTracks()[0], range = this.capabilities().zoom
    if (!track || !range) return
    const next = !this.zoomed
    const zoom = next ? Math.min(range.max, Math.max(range.min, 2)) : range.min
    try {
      await track.applyConstraints({ advanced: [{ zoom } as MediaTrackConstraintSet] })
      if (this.stream?.getVideoTracks()[0] !== track) return
      this.zoomed = next
      if (this.options.zoom) this.options.zoom.textContent = `${Number(zoom.toFixed(1))}×`
    } catch { if (this.stream?.getVideoTracks()[0] === track) this.say('This camera could not change zoom.') }
  }

  private async focus(e: MouseEvent) {
    const track = this.stream?.getVideoTracks()[0]
    if (!track) return
    if (this.video.paused) await this.video.play().catch(() => {})
    const caps = this.capabilities()
    if (!caps.focusMode?.includes('single-shot') || !caps.pointsOfInterest) return
    const r = this.video.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
    try { await track.applyConstraints({ advanced: [{ focusMode: 'single-shot', pointsOfInterest: [{ x, y }] } as MediaTrackConstraintSet] }) }
    catch { /* autofocus stays available when a camera declines a focus point */ }
  }

  private async decoder(alive: () => boolean): Promise<(video: HTMLVideoElement) => Promise<Code | null>> {
    type Detector = { detect(v: HTMLVideoElement): Promise<{ rawValue: string; cornerPoints?: CodeCorner[] }[]> }
    const Native = (globalThis as unknown as { BarcodeDetector?: { new(o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector
    if (Native) {
      try {
        if ((await Native.getSupportedFormats()).includes('qr_code')) {
          const detector = new Native({ formats: ['qr_code'] })
          let fallback: ReturnType<Scanner['fallback']> | undefined
          return async (video) => {
            if (fallback) return fallback(video)
            try {
              const code = (await detector.detect(video))[0]
              return code ? { text: code.rawValue, corners: code.cornerPoints?.map(p => ({ x: p.x / video.videoWidth, y: p.y / video.videoHeight })) } : null
            }
            catch {
              if (!alive()) return null
              fallback = this.fallback()
              return fallback(video)
            }
          }
        }
      } catch { /* unsupported formats: use the bundled worker */ }
    }
    return alive() ? this.fallback() : async () => null
  }

  /** Pixel copies stay small; jsQR runs in one worker with at most one frame in flight. */
  private fallback() {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    try {
      if (!ctx) throw new Error('No camera canvas')
      const worker = cameraWorker('qr')
      this.worker = worker
      worker.onmessage = (event: MessageEvent<{ id: number; text: string | null; corners?: CodeCorner[] }>) => {
        if (this.worker !== worker || event.data.id !== this.sequence) return
        clearTimeout(this.workerTimer)
        const pending = this.pending
        this.pending = null
        pending?.(typeof event.data.text === 'string' ? { text: event.data.text, corners: event.data.corners } : null)
      }
      worker.onerror = () => { if (this.worker === worker) this.failedWorker() }
      worker.onmessageerror = () => { if (this.worker === worker) this.failedWorker() }
    } catch { this.failedWorker() }
    return async (video: HTMLVideoElement) => {
      if (!ctx || !this.worker || this.pending) return null
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight))
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      if (!canvas.width || !canvas.height) return null
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
      return new Promise<Code | null>((resolve) => {
        this.pending = resolve
        this.workerTimer = setTimeout(() => this.failedWorker(), 2500)
        try { this.worker!.postMessage({ id: ++this.sequence, width: frame.width, height: frame.height, pixels: frame.data.buffer }, [frame.data.buffer]) }
        catch { this.failedWorker() }
      })
    }
  }

  private failedWorker() {
    this.decoding = false
    this.releaseWorker()
    this.unavailable('The QR reader could not start. Enter the code shown on your screen.')
  }

  private releaseWorker() {
    clearTimeout(this.workerTimer)
    const worker = this.worker
    this.worker = null
    worker?.terminate()
    const pending = this.pending
    this.pending = null
    pending?.(null)
  }
}
