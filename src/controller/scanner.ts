/** The camera belongs to one open scanner. Closing even during permission or decoding stops every late track. */
export class Scanner {
  private stream: MediaStream | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private lit = false
  private seen = { text: '', at: 0 }

  constructor(private video: HTMLVideoElement, private torch: HTMLButtonElement, private say: (s: string) => void, private found: (s: string) => void) {
    video.muted = true
    video.playsInline = true
    video.autoplay = true
    torch.hidden = true
    torch.setAttribute('aria-pressed', 'false')
    torch.onclick = () => void this.light()
  }

  /**
   * Open the camera and read codes from it; call from a tap. The camera is asked for inside the tap (a browser that
   * ties the camera or its picture to a gesture keeps it), and a phone without a built-in code reader starts fetching
   * the bundled one meanwhile.
   */
  async start() {
    this.stop()
    const generation = this.generation
    const alive = () => generation === this.generation
    this.say('Point at the code on your screen')
    if (!(globalThis as { BarcodeDetector?: unknown }).BarcodeDetector) void import('jsqr').catch(() => { /* fetched again when it's needed */ })
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
    } catch (e) {
      if (!alive()) return
      this.stop()
      this.say(e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Camera access is off. Allow it in your browser, or enter a code.'
        : 'Camera unavailable. Enter the code shown on your screen.')
      return
    }
    if (!alive()) { stream.getTracks().forEach((t) => t.stop()); return }
    this.stream = stream
    this.video.srcObject = stream
    const track = stream.getVideoTracks()[0]
    this.torch.hidden = !(track?.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean })?.torch
    // A browser that won't show the picture yet (it wants a tap for it) shows it on the next tap: the camera is fine.
    await this.video.play().catch(() => {
      if (!alive()) return
      this.say('Tap the picture to start the camera')
      this.video.addEventListener('click', () => void this.video.play().then(() => { if (alive()) this.say('Point at the code on your screen') }, () => {}), { once: true })
    })
    if (!alive()) return
    const decode = await this.decoder(alive)
    const scan = async () => {
      if (!alive()) return
      try {
        if (this.video.readyState >= 2) {
          const text = await decode(this.video)
          if (!alive()) return
          if (text && (text !== this.seen.text || Date.now() - this.seen.at > 2500)) {
            this.seen = { text, at: Date.now() }
            this.found(text)
          }
        }
      } catch { /* a camera frame can arrive during a resize */ }
      if (alive()) this.timer = setTimeout(() => void scan(), 150)
    }
    void scan()
  }

  stop() {
    ++this.generation
    clearTimeout(this.timer)
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.pause()
    this.video.srcObject = null
    this.lit = false
    this.torch.hidden = true
    this.torch.setAttribute('aria-pressed', 'false')
  }

  private async light() {
    const track = this.stream?.getVideoTracks()[0]
    if (!track) return
    try {
      const lit = !this.lit
      await track.applyConstraints({ advanced: [{ torch: lit } as MediaTrackConstraintSet] })
      if (this.stream?.getVideoTracks()[0] !== track) return
      this.lit = lit
      this.torch.setAttribute('aria-pressed', String(lit))
    } catch { this.say('This camera could not turn the torch on.') }
  }

  private async decoder(alive: () => boolean): Promise<(video: HTMLVideoElement) => Promise<string | null>> {
    type Detector = { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> }
    const Native = (globalThis as unknown as { BarcodeDetector?: { new(o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector
    if (Native) {
      try {
        if ((await Native.getSupportedFormats()).includes('qr_code')) {
          const detector = new Native({ formats: ['qr_code'] })
          // A detector advertised but broken by the browser falls back on its first failure.
          let fallback: Awaited<ReturnType<Scanner['fallback']>> | undefined
          return async (video) => {
            if (fallback) return fallback(video)
            try { return (await detector.detect(video))[0]?.rawValue ?? null }
            catch {
              if (!alive()) return null
              fallback = await this.fallback()
              return alive() ? fallback(video) : null
            }
          }
        }
      } catch { /* unsupported formats: use the bundled decoder */ }
    }
    return alive() ? this.fallback() : async () => null
  }

  /**
   * The bundled decoder, fetched the first time it's needed. A fetch that fails (the phone went offline) is tried again
   * frame by frame while the camera keeps running, rather than taking the camera down.
   */
  private async fallback() {
    type Read = typeof import('jsqr').default
    let jsQR: Read | null = null
    let loading: Promise<void> | null = null
    const load = () => (loading ??= import('jsqr').then((m) => { jsQR = m.default }, () => { loading = null }))
    await load()
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    return async (video: HTMLVideoElement) => {
      if (!jsQR) { await load(); if (!jsQR) return null }
      const scale = Math.min(1, 960 / video.videoWidth)
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      if (!canvas.width || !canvas.height) return null
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
      return jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' })?.data ?? null
    }
  }
}
