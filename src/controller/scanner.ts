import { cameraWorker } from '../ui/camera-worker'
import { clampZoom, pinchZoom, zoomCrop, zoomMapping } from './scan-zoom'

type CameraState = 'opening' | 'ready' | 'unavailable'
export type CodeCorner = { x: number; y: number }
type Code = { text: string; corners?: CodeCorner[] }
type CameraOptions = {
  scan?: boolean
  fps?: 30 | 60
  ended?: () => void
  zoom?: HTMLButtonElement
  zoomSlider?: HTMLInputElement
  focus?: HTMLButtonElement
  zoomChanged?: (level: number, digital: number) => void
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
  private level = 1
  private digital = 1
  private hardwareFailed = false
  private hardwareScale = 1
  private zoomTimer: ReturnType<typeof setTimeout> | undefined
  private rememberTimer: ReturnType<typeof setTimeout> | undefined
  private zoomBusy = false
  private zoomKey = ''
  private pointers = new Map<number, { x: number; y: number }>()
  private pinch = { distance: 0, level: 1 }
  private tap = { at: 0, x: 0, y: 0 }
  private down = { at: 0, x: 0, y: 0 }
  private gestured = false
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
      options.zoom.onclick = () => this.setZoom(this.level < 1.5 ? 2 : 1)
    }
    video.onclick = (e) => void this.focus(e)
    if (options.zoomSlider) options.zoomSlider.oninput = () => this.setZoom(Number(options.zoomSlider!.value))
    if (options.focus) { options.focus.hidden = true; options.focus.onclick = () => void this.focus() }
    if (options.scan !== false && video.addEventListener) {
      video.addEventListener('pointerdown', e => {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        video.setPointerCapture(e.pointerId)
        this.down = { at: performance.now(), x: e.clientX, y: e.clientY }
        if (this.pointers.size === 2) { this.gestured = true; this.tap.at = 0; this.pinch = { distance: this.distance(), level: this.level } }
      })
      video.addEventListener('pointermove', e => {
        if (!this.pointers.has(e.pointerId)) return
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (this.pointers.size === 2) this.setZoom(pinchZoom(this.pinch.level, this.pinch.distance, this.distance()))
      })
      const release = (e: PointerEvent) => {
        if (!this.pointers.has(e.pointerId)) return
        this.pointers.delete(e.pointerId)
        if (e.type === 'pointerup' && !this.gestured && performance.now() - this.down.at < 280 && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 16) {
          const at = performance.now()
          if (this.tap.at && at - this.tap.at < 320 && Math.hypot(e.clientX - this.tap.x, e.clientY - this.tap.y) < 24) { this.setZoom(this.level < 1.5 ? 2 : 1); this.tap.at = 0 }
          else this.tap = { at, x: e.clientX, y: e.clientY }
        }
        if (!this.pointers.size) this.gestured = false
      }
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) video.addEventListener(type, release as EventListener)
    }
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
        ? { facingMode: { ideal: this.front ? 'user' : 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: this.options.fps ?? 60, max: this.options.fps ?? 120 } }
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
    if (this.options.ended) stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => { if (alive()) this.options.ended?.() }, { once: true }))
    this.video.srcObject = stream
    const facing = stream.getVideoTracks()[0]?.getSettings?.().facingMode
    if (facing) this.front = facing === 'user'
    if (this.video.dataset) this.video.dataset.mirrored = String(this.front)
    const inputs = await navigator.mediaDevices.enumerateDevices?.().catch(() => []) ?? []
    if (!alive()) return
    this.options.facing?.(this.front, inputs.filter(d => d.kind === 'videoinput').length > 1)
    const caps = this.capabilities()
    if (this.options.scan === false && caps.frameRate?.max) {
      const fps = this.options.fps ?? 120
      await stream.getVideoTracks()[0]?.applyConstraints({ frameRate: { ideal: Math.min(fps, caps.frameRate.max), max: fps } }).catch(() => {})
      if (!alive()) return
    }
    this.torch.hidden = !caps.torch
    if (this.options.zoom) this.options.zoom.hidden = this.options.scan === false && !(caps.zoom && caps.zoom.max > caps.zoom.min)
    if (this.options.zoomSlider) this.options.zoomSlider.disabled = false
    if (this.options.focus) this.options.focus.hidden = !caps.focusMode?.includes('single-shot')
    if (this.options.scan !== false) {
      const device = stream.getVideoTracks()[0]?.getSettings?.().deviceId
      this.zoomKey = device ? `obpal.scan.zoom.${device}` : ''
      let level = 1
      try { if (this.zoomKey) level = Number(localStorage.getItem(this.zoomKey) ?? 1) } catch { /* session only */ }
      this.setZoom(level)
    }
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
    clearTimeout(this.rememberTimer)
    this.rememberTimer = undefined
    this.rememberZoom()
    clearTimeout(this.timer)
    clearTimeout(this.zoomTimer)
    this.zoomTimer = undefined
    this.zoomBusy = false
    this.timer = undefined
    this.decoding = false
    this.releaseWorker()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.pause()
    this.video.srcObject = null
    this.lit = false
    this.level = this.digital = 1
    this.hardwareFailed = false
    this.hardwareScale = 1
    this.zoomKey = ''
    this.pointers.clear()
    this.tap.at = 0
    this.gestured = false
    this.video.style?.removeProperty('--scan-zoom')
    this.seen = { text: '', at: 0 }
    this.torch.hidden = true
    this.torch.setAttribute('aria-pressed', 'false')
    if (this.options.zoom) { this.options.zoom.hidden = true; this.options.zoom.textContent = '1×' }
    if (this.options.zoomSlider) this.options.zoomSlider.disabled = true
    if (this.options.focus) this.options.focus.hidden = true
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
      await this.constrain(track, { torch: lit } as MediaTrackConstraintSet)
      if (this.stream?.getVideoTracks()[0] !== track) return
      this.lit = lit
      this.torch.setAttribute('aria-pressed', String(lit))
    } catch { if (this.stream?.getVideoTracks()[0] === track) this.say('This camera could not change the torch.') }
  }

  private distance() { const [a, b] = [...this.pointers.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 }

  private setZoom(value: number) {
    if (!this.stream) return
    this.level = Math.max(this.hardwareFailed ? this.hardwareScale : 1, clampZoom(value))
    const range = this.capabilities().zoom
    if (this.options.scan === false && range) this.level = Math.min(this.level, range.max / Math.max(range.min, Math.min(range.max, 1)))
    if (!this.rememberTimer && this.zoomKey) this.rememberTimer = setTimeout(() => { this.rememberTimer = undefined; this.rememberZoom() }, 250)
    const mapping = zoomMapping(this.level, this.hardwareFailed ? undefined : this.capabilities().zoom)
    if (mapping.hardware !== null && !this.zoomTimer && !this.zoomBusy) this.zoomTimer = setTimeout(() => { this.zoomTimer = undefined; void this.applyZoom() }, 100)
    this.presentZoom(Math.max(1, this.level / this.hardwareScale))
  }

  private rememberZoom() {
    if (this.zoomKey) try { localStorage.setItem(this.zoomKey, String(this.level)) } catch { /* session only */ }
  }

  private presentZoom(digital: number) {
    this.digital = digital
    this.video.style?.setProperty('--scan-zoom', String(digital))
    if (this.options.zoom) this.options.zoom.textContent = `${Number(this.level.toFixed(1))}×`
    if (this.options.zoomSlider) { this.options.zoomSlider.value = String(this.level); this.options.zoomSlider.setAttribute('aria-valuetext', `${this.level.toFixed(1)} times zoom`) }
    this.options.zoomChanged?.(this.level, digital)
  }

  /** Coalesce gestures, serialize camera requests, and never wait for them in the decoder loop. */
  private async applyZoom() {
    const track = this.stream?.getVideoTracks()[0]
    if (!track) return
    const generation = this.generation, level = this.level
    const mapping = zoomMapping(level, this.hardwareFailed ? undefined : this.capabilities().zoom)
    if (mapping.hardware === null) return
    this.zoomBusy = true
    try {
      await this.constrain(track, { zoom: mapping.hardware } as MediaTrackConstraintSet)
      if (generation !== this.generation) return
      const range = this.capabilities().zoom!
      const base = Math.max(range.min, Math.min(range.max, 1))
      const actual = (track.getSettings?.() as MediaTrackSettings & { zoom?: number })?.zoom ?? mapping.hardware
      this.hardwareScale = actual / base
      this.presentZoom(Math.max(1, this.level / this.hardwareScale))
    } catch {
      if (generation !== this.generation) return
      this.hardwareFailed = true
      // Retain any already-applied optical magnification when falling back.
      const actual = (track.getSettings?.() as MediaTrackSettings & { zoom?: number })?.zoom ?? 1
      const range = this.capabilities().zoom!
      this.hardwareScale = actual / Math.max(range.min, Math.min(range.max, 1))
      this.level = Math.max(this.level, this.hardwareScale)
      if (this.options.scan === false) {
        this.level = this.hardwareScale
        this.presentZoom(1)
        this.say('This camera could not change zoom.')
        return
      }
      this.presentZoom(Math.max(1, this.level / this.hardwareScale))
      this.say('This camera could not change zoom. Using digital zoom.')
    } finally {
      if (generation === this.generation) { this.zoomBusy = false; if (level !== this.level) this.setZoom(this.level) }
    }
  }

  private constrain(track: MediaStreamTrack, values: MediaTrackConstraintSet) {
    const previous = track.getConstraints?.() ?? {}
    const advanced = Object.assign({}, ...previous.advanced ?? [], values)
    return track.applyConstraints({ ...previous, advanced: [advanced] })
  }

  private async focus(e?: MouseEvent) {
    const track = this.stream?.getVideoTracks()[0]
    if (!track) return
    if (this.video.paused) await this.video.play().catch(() => {})
    const caps = this.capabilities()
    if (!caps.focusMode?.includes('single-shot')) return
    const r = this.video.getBoundingClientRect()
    const width = this.video.clientWidth, height = this.video.clientHeight
    let x = e ? Math.max(0, Math.min(1, (e.clientX - r.left - (r.width - width) / 2) / width)) : .5
    const y = e ? Math.max(0, Math.min(1, (e.clientY - r.top - (r.height - height) / 2) / height)) : .5
    if (this.front) x = 1 - x
    const crop = this.crop()
    try { await this.constrain(track, { focusMode: 'single-shot', ...(caps.pointsOfInterest ? { pointsOfInterest: [{ x: (crop.x + x * crop.width) / this.video.videoWidth, y: (crop.y + y * crop.height) / this.video.videoHeight }] } : {}) } as MediaTrackConstraintSet) }
    catch { /* autofocus stays available when a camera declines a focus point */ }
  }

  private async decoder(alive: () => boolean): Promise<(video: HTMLVideoElement) => Promise<Code | null>> {
    type Detector = { detect(v: HTMLVideoElement | HTMLCanvasElement): Promise<{ rawValue: string; cornerPoints?: CodeCorner[] }[]> }
    const Native = (globalThis as unknown as { BarcodeDetector?: { new(o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector
    if (Native) {
      try {
        if ((await Native.getSupportedFormats()).includes('qr_code')) {
          const detector = new Native({ formats: ['qr_code'] })
          let canvas: HTMLCanvasElement | undefined
          let fallback: ReturnType<Scanner['fallback']> | undefined
          return async (video) => {
            if (fallback) return fallback(video)
            try {
              const crop = this.crop()
              const cropped = crop.width < video.videoWidth || crop.height < video.videoHeight
              if (cropped) { canvas ??= document.createElement('canvas'); this.frame(canvas, video, crop) }
              const source = cropped ? canvas! : video
              const code = (await detector.detect(source))[0]
              const width = cropped ? canvas!.width : video.videoWidth, height = cropped ? canvas!.height : video.videoHeight
              return code ? { text: code.rawValue, corners: code.cornerPoints?.map(p => ({ x: (crop.x + p.x / width * crop.width) / video.videoWidth, y: (crop.y + p.y / height * crop.height) / video.videoHeight })) } : null
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
      const crop = this.crop()
      this.frame(canvas, video, crop)
      if (!canvas.width || !canvas.height) return null
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
      return new Promise<Code | null>((resolve) => {
        this.pending = code => resolve(code ? { ...code, corners: code.corners?.map(p => ({ x: (crop.x + p.x * crop.width) / video.videoWidth, y: (crop.y + p.y * crop.height) / video.videoHeight })) } : null)
        this.workerTimer = setTimeout(() => this.failedWorker(), 2500)
        try { this.worker!.postMessage({ id: ++this.sequence, width: frame.width, height: frame.height, pixels: frame.data.buffer }, [frame.data.buffer]) }
        catch { this.failedWorker() }
      })
    }
  }

  private crop() {
    return zoomCrop(this.video.videoWidth, this.video.videoHeight, this.video.clientWidth, this.video.clientHeight, this.digital)
  }

  private frame(canvas: HTMLCanvasElement, video: HTMLVideoElement, crop: ReturnType<typeof zoomCrop>) {
    const scale = Math.min(1, 720 / Math.max(crop.width, crop.height))
    const width = Math.round(crop.width * scale), height = Math.round(crop.height * scale)
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    if (canvas.width && canvas.height) canvas.getContext('2d')?.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height)
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
