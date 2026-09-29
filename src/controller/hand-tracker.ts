/** Camera-frame-driven hand tracking. Inference has one in-flight frame and never builds a latency queue. */
import { encodeHand, HandFlag, type HandState, type Vec3 } from '@obpal/core'
import type { HandLandmarkerResult } from '@mediapipe/tasks-vision'
import { cameraWorker } from '../ui/camera-worker'
import { HandBandwidth, HandGestures, LandmarkFilter, OneEuro, palmPosition } from './hand-signal'
import { coverPoint } from '../ui/camera-space'

export interface HandMetrics {
  delegate: string
  cameraFps: number
  trackingFps: number
  sentFps: number
  latencyMs: number
  latencyP95Ms: number
  inferenceMs: number
  width: number
  height: number
  frames: number
  packets: number
  dropped: number
  bytesPerSecond: number
  clock: 'capture' | 'presentation'
}
interface Options {
  send(packet: ArrayBuffer): boolean
  sequence(): number
  generation(): number
  timeOrigin: number
  activeHint?: string
  say(text: string): void
  metrics(value: HandMetrics): void
  loading?(progress: number | null): void
  error?(text: string): void
  hand?(gestures: number, handedness: string, palm: Vec3 | null): void
}
const EDGES = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [5, 9, 10, 11, 12], [9, 13, 14, 15, 16], [13, 17, 18, 19, 20], [0, 17]]
const finitePoints = (p: { x: number; y: number; z: number }[] | undefined) => Array.isArray(p) && p.length === 21
  && Array.from(p).every(v => v && [v.x, v.y, v.z].every(n => Number.isFinite(n) && Math.abs(n) <= 4))

export class HandTracker {
  private worker: Worker | null = null
  private live = false
  private busy = false
  private ready = false
  private callback = 0
  private animation = 0
  private lastVideo = -1
  private gen = 0
  private identity = ''
  private world = new LandmarkFilter()
  private screen = new LandmarkFilter()
  private palm = [new OneEuro(), new OneEuro(), new OneEuro()]
  private gestures = new HandGestures()
  private budget = new HandBandwidth()
  private began = 0
  private sampleAt = 0
  private frames = 0
  private sent = 0
  private cameraFrames = 0
  private firstPresented = -1
  private lastPresented = 0
  private latency: number[] = []
  private costs: number[] = []
  private resizing = false
  private resizedAt = 0
  private testResult: HandLandmarkerResult | null = null
  private readonly context: CanvasRenderingContext2D
  readonly stats: HandMetrics = { delegate: 'loading', cameraFps: 0, trackingFps: 0, sentFps: 0, latencyMs: 0, latencyP95Ms: 0, inferenceMs: 0, width: 0, height: 0, frames: 0, packets: 0, dropped: 0, bytesPerSecond: 0, clock: 'presentation' }

  constructor(private video: HTMLVideoElement, private overlay: HTMLCanvasElement, private options: Options) {
    this.context = overlay.getContext('2d')!
  }

  start() {
    if (this.live) return
    this.busy = false; this.ready = false; this.identity = ''; this.lastVideo = -1
    this.frames = this.sent = this.cameraFrames = 0; this.firstPresented = -1; this.lastPresented = 0
    this.latency = []; this.costs = []; this.testResult = null
    this.stats.frames = this.stats.packets = this.stats.dropped = 0
    this.budget = new HandBandwidth()
    this.live = true
    this.began = this.sampleAt = performance.now()
    this.gen = this.options.generation()
    this.options.say('')
    this.options.loading?.(0)
    try {
      const worker = cameraWorker('hand')
      this.worker = worker
      worker.onmessage = e => {
        if (!this.live || this.worker !== worker) return
        const m = e.data
        if (m.type === 'ready') {
          this.ready = true; this.stats.delegate = m.delegate
          this.options.loading?.(null)
          this.options.say('Show your hand')
        } else if (m.type === 'progress') {
          this.options.loading?.(m.value)
        } else if (m.type === 'result') {
          this.busy = false; this.stats.delegate = m.delegate
          this.result(m.result, m.at, m.capture, m.elapsed)
        } else if (m.type === 'error') this.fail(m.message)
      }
      worker.onerror = () => { if (this.worker === worker) this.fail('Hand tracking is unavailable. Close the camera and try again.') }
      worker.postMessage({ type: 'start' })
      this.schedule()
    } catch { this.fail('Hand tracking is unavailable in this browser.') }
  }

  stop() {
    if (!this.live) return
    this.lost(performance.now(), true)
    this.live = false; this.ready = false; this.busy = false
    this.worker?.terminate(); this.worker = null
    if (this.callback) this.video.cancelVideoFrameCallback(this.callback)
    cancelAnimationFrame(this.animation)
    this.context.clearRect(0, 0, this.overlay.width, this.overlay.height)
  }

  /** Called only by the controller's explicitly enabled loopback e2e seam. It still uses real camera frame timing. */
  injectForTest(result: HandLandmarkerResult) { this.testResult = result }

  private fail(message: string) {
    this.stop()
    this.options.say(message)
    this.options.error?.(message)
  }

  private schedule() {
    if (!this.live) return
    if (this.video.requestVideoFrameCallback) {
      this.callback = this.video.requestVideoFrameCallback((at, meta) => {
        this.schedule()
        if (this.firstPresented < 0) this.firstPresented = meta.presentedFrames - 1
        this.lastPresented = meta.presentedFrames
        const capture = meta.captureTime ?? meta.presentationTime
        this.stats.clock = meta.captureTime === undefined ? 'presentation' : 'capture'
        void this.frame(at, capture)
      })
    } else {
      this.animation = requestAnimationFrame(at => {
        this.schedule()
        if (this.video.currentTime === this.lastVideo) return
        this.lastVideo = this.video.currentTime
        this.firstPresented = 0; this.lastPresented++
        void this.frame(at, at)
      })
    }
  }

  private async frame(at: number, capture: number) {
    this.cameraFrames++
    if (!this.ready || this.busy || this.video.readyState < 2) return
    if (this.testResult) {
      this.stats.delegate = 'synthetic'
      this.result(this.testResult, at, capture, 0)
      return
    }
    this.busy = true
    const worker = this.worker
    let bitmap: ImageBitmap | null = null
    try {
      bitmap = await createImageBitmap(this.video)
      if (!this.live || this.worker !== worker) { bitmap.close(); return }
      worker!.postMessage({ type: 'frame', frame: bitmap, at, capture }, [bitmap])
      bitmap = null
    } catch { bitmap?.close(); if (this.worker === worker) this.busy = false }
  }

  private result(result: HandLandmarkerResult, at: number, capture: number, cost: number) {
    this.frames++; this.stats.frames++
    this.costs.push(cost); if (this.costs.length > 240) this.costs.shift()
    const world = result?.worldLandmarks?.[0], image = result?.landmarks?.[0], label = result?.handedness?.[0]?.[0]
    const valid = finitePoints(world) && finitePoints(image) && Number.isFinite(label?.score) && label.score >= .6 && label.score <= 1
    if (!valid) this.lost(at, false, capture)
    else {
      const mirrored = this.video.dataset?.mirrored === 'true'
      const handedness = label.categoryName === 'Left' ? (mirrored ? 'right' : 'left') : label.categoryName === 'Right' ? (mirrored ? 'left' : 'right') : 'unknown'
      if (this.identity !== handedness) {
        this.identity = handedness; this.gen = this.options.generation()
        this.world.reset(); this.screen.reset(); this.palm.forEach(f => f.reset()); this.gestures.reset()
      }
      const landmarks = this.world.sample(world.map(p => [mirrored ? -p.x : p.x, -p.y, -p.z]), at / 1000)
      const points = image.map(p => [p.x, p.y, p.z] as Vec3)
      const translation = palmPosition(landmarks, points, this.video.videoWidth, this.video.videoHeight)
      if (mirrored) translation[0] *= -1
      const p = translation.map((n, i) => this.palm[i].sample(n, at / 1000)) as Vec3
      if (p.some(n => !Number.isFinite(n) || Math.abs(n) > 16)) { this.lost(at, false, capture); return }
      const gestures = this.gestures.sample(landmarks)
      const depth = -p[2]
      const width = this.overlay.clientWidth || this.video.videoWidth, height = this.overlay.clientHeight || this.video.videoHeight
      const edge = [4, 8, 12, 16, 20].some(i => {
        const point = coverPoint(points[i][0] * this.video.videoWidth, points[i][1] * this.video.videoHeight, this.video.videoWidth, this.video.videoHeight, width, height, mirrored)
        return point.x < width * .04 || point.x > width * .96 || point.y < height * .04 || point.y > height * .96
      })
      const outside = depth < .2 || depth > .6 || edge
      this.options.say(depth > .6 ? 'Closer' : depth < .2 || edge ? 'Farther' : gestures & 4 ? 'Frozen' : gestures & 2 ? 'Orbit' : gestures & 1 ? 'Grab' : 'Hover')
      this.options.hand?.(gestures, handedness, p)
      this.transmit({ flags: HandFlag.tracked, handedness, confidence: label.score, gestures, p, landmarks }, at, capture)
      this.draw(this.screen.sample(points, at / 1000), gestures, depth, outside, mirrored)
    }
    if (performance.now() - this.sampleAt >= 1000) this.measure()
  }

  private transmit(state: Pick<HandState, 'flags' | 'handedness' | 'confidence' | 'gestures' | 'p' | 'landmarks'>, at: number, capture = at, force = false) {
    const now = performance.now()
    if (!force && !this.budget.take(now)) { this.stats.dropped++; return }
    const packet = encodeHand({ ...state, seq: this.options.sequence(), t: Math.round(Math.max(0, capture - this.options.timeOrigin) * 1000) >>> 0, gen: this.gen })
    if (this.options.send(packet)) {
      this.sent++; this.stats.packets++
      this.latency.push(Math.max(0, performance.now() - capture)); if (this.latency.length > 240) this.latency.shift()
    }
  }

  private lost(at: number, force = false, capture = at) {
    if (this.identity) this.options.say('Holding')
    this.identity = ''
    this.options.hand?.(0, 'unknown', null)
    this.transmit({ flags: 0, handedness: 'unknown', confidence: 0, gestures: 0, p: [0, 0, 0], landmarks: Array.from({ length: 21 }, () => [0, 0, 0]) }, at, capture, force)
    if (this.overlay.dataset) this.overlay.dataset.lost = 'true'
  }

  private measure() {
    const now = performance.now(), seconds = (now - this.sampleAt) / 1000
    const avg = (a: number[]) => a.reduce((p, n) => p + n, 0) / Math.max(1, a.length)
    const sorted = this.latency.slice().sort((a, b) => a - b)
    Object.assign(this.stats, {
      cameraFps: (this.lastPresented - Math.max(0, this.firstPresented)) * 1000 / Math.max(1, now - this.began),
      trackingFps: this.frames / seconds, sentFps: this.sent / seconds, bytesPerSecond: this.sent * 144 / seconds,
      latencyMs: avg(this.latency), latencyP95Ms: sorted[Math.floor((sorted.length - 1) * .95)] ?? 0,
      inferenceMs: avg(this.costs), width: this.video.videoWidth, height: this.video.videoHeight,
    })
    this.options.metrics({ ...this.stats })
    const delivered = this.cameraFrames / seconds
    this.frames = 0; this.sent = 0; this.cameraFrames = 0; this.sampleAt = now
    void this.adapt(delivered, now)
  }

  /** Lower capture resolution before sacrificing cadence; step back up only after sustained spare capacity. */
  private async adapt(cameraFps: number, now: number) {
    if (this.resizing || now - this.resizedAt < 4000 || this.stats.delegate === 'synthetic') return
    const track = (this.video.srcObject as MediaStream | null)?.getVideoTracks()[0]
    if (!track) return
    const width = this.video.videoWidth, interval = 1000 / Math.max(15, cameraFps)
    const slow = this.stats.inferenceMs > interval * .85 || this.stats.trackingFps < cameraFps * .85
    const fast = this.stats.inferenceMs < interval * .35 && this.stats.trackingFps >= cameraFps * .95
    const target = slow ? Math.max(320, Math.round(width * .75)) : fast && now - this.resizedAt > 12000 ? Math.min(1280, Math.round(width * 1.25)) : width
    if (target === width) return
    this.resizing = true; this.resizedAt = now
    try { await track.applyConstraints({ width: { ideal: target }, height: { ideal: Math.round(target * this.video.videoHeight / width) } }) }
    catch { /* keep the supported capture settings */ }
    finally { this.resizing = false }
  }

  private draw(points: Vec3[], gestures: number, depth: number, outside: boolean, mirrored: boolean) {
    const width = this.overlay.clientWidth || this.video.videoWidth, height = this.overlay.clientHeight || this.video.videoHeight
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    if (this.overlay.width !== Math.round(width * dpr)) this.overlay.width = Math.round(width * dpr)
    if (this.overlay.height !== Math.round(height * dpr)) this.overlay.height = Math.round(height * dpr)
    if (this.overlay.dataset) this.overlay.dataset.lost = 'false'
    const c = this.context
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.clearRect(0, 0, width, height)
    const mapped = points.map(p => coverPoint(p[0] * this.video.videoWidth, p[1] * this.video.videoHeight, this.video.videoWidth, this.video.videoHeight, width, height, mirrored))
    const alpha = outside ? .45 : 1
    c.strokeStyle = getComputedStyle(this.overlay).color
    c.fillStyle = c.strokeStyle; c.lineWidth = 2.5 * Math.max(.7, Math.min(1.3, .4 / depth)); c.lineCap = 'round'; c.lineJoin = 'round'
    c.globalAlpha = alpha * (gestures & 2 ? .26 : .10)
    c.beginPath()
    ;[0, 5, 9, 13, 17].forEach((n, i) => { const p = mapped[n]; if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y) })
    c.closePath(); c.fill()
    c.globalAlpha = alpha * .85
    c.shadowColor = `color-mix(in srgb, ${c.strokeStyle} 45%, transparent)`; c.shadowBlur = 8 * dpr
    for (const edge of EDGES) {
      c.beginPath()
      edge.forEach((n, i) => { const p = mapped[n]; if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y) })
      c.stroke()
    }
    c.shadowBlur = 0
    for (const i of [4, 8, 12, 16, 20]) {
      const p = mapped[i]
      c.beginPath(); c.arc(p.x, p.y, 3.5, 0, Math.PI * 2); c.fill()
    }
    c.lineWidth = 2
    c.beginPath(); c.arc((mapped[4].x + mapped[8].x) / 2, (mapped[4].y + mapped[8].y) / 2, 9, 0, Math.PI * 2)
    if (gestures & 1) c.fill(); else c.stroke()
    c.globalAlpha = 1
  }
}
