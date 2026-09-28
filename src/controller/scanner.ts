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

  async start() {
    this.stop()
    const generation = this.generation
    this.say('Point at the code on your screen')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
      if (generation !== this.generation) { stream.getTracks().forEach((t) => t.stop()); return }
      this.stream = stream
      this.video.srcObject = stream
      const track = stream.getVideoTracks()[0]
      this.torch.hidden = !(track?.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean })?.torch
      await this.video.play()
      if (generation !== this.generation) return
      const decode = await this.decoder(() => generation === this.generation)
      const scan = async () => {
        if (generation !== this.generation) return
        try {
          if (this.video.readyState >= 2) {
            const text = await decode(this.video)
            if (generation !== this.generation) return
            if (text && (text !== this.seen.text || Date.now() - this.seen.at > 2500)) {
              this.seen = { text, at: Date.now() }
              this.found(text)
            }
          }
        } catch { /* a camera frame can arrive during a resize */ }
        if (generation === this.generation) this.timer = setTimeout(() => void scan(), 150)
      }
      if (generation === this.generation) void scan()
    } catch (e) {
      if (generation !== this.generation) return
      this.stop()
      this.say(e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Camera access is off. Allow it in your browser, or enter a code.'
        : 'Camera unavailable. Enter the code shown on your screen.')
    }
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

  private async fallback() {
    const { default: jsQR } = await import('jsqr')
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    return async (video: HTMLVideoElement) => {
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
