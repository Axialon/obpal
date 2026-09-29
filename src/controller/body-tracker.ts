/** One camera frame in flight, shared by phone BODY and local webcam capture. Nothing here stores capture data. */
import { BODY_BYTES, encodeBody, encodeHand, HandFlag, type HandState, type Vec3 } from '@obpal/core'
import type { HandLandmarkerResult } from '@mediapipe/tasks-vision'
import { cameraWorker } from '../ui/camera-worker'
import { BodyBandwidth, BodySignal, emptyBody, type BodyResult, type BodySample } from './body-signal'
import { LandmarkFilter, palmPosition } from './hand-signal'

export interface BodyMetrics {
  delegate: string
  frames: number
  packets: number
  handPackets: number
  dropped: number
  trackingFps: number
  sentFps: number
  inferenceMs: number
  latencyP95Ms: number
  bytesPerSecond: number
  width: number
  height: number
  clock: 'capture' | 'presentation'
}
interface Options {
  send(packet: ArrayBuffer): boolean
  sequence(): number
  generation(): number
  timeOrigin: number
  fps?: 30 | 60
  hand?: { send(packet: ArrayBuffer): boolean; sequence(): number; generation(): number }
  say(text: string): void
  loading?(progress: number | null): void
  metrics?(metrics: BodyMetrics): void
  error?(text: string): void
  fingersOff?(): void
}
const edges = [[11, 12, 24, 23, 11], [11, 13, 15], [12, 14, 16], [23, 25, 27, 29, 31, 27], [24, 26, 28, 30, 32, 28], [7, 0, 8]]

export class BodyTracker {
  private worker: Worker | null = null
  private live = false
  private ready = false
  private busy = false
  private callback = 0
  private animation = 0
  private lastVideo = -1
  private lastFrame = -Infinity
  private lastHand = -Infinity
  private pendingAt = -1
  private gen = 0
  private handGen = 0
  private handSide = ''
  private fingers = false
  private signal = new BodySignal()
  private handFilter = new LandmarkFilter()
  private budget = new BodyBandwidth()
  private injected: { body: BodyResult; hand?: HandLandmarkerResult } | null = null
  private sampleAt = 0
  private sampledFrames = 0
  private sampledPackets = 0
  private sampledBytes = 0
  private costs: number[] = []
  private latencies: number[] = []
  private rate: number
  private resizedAt = 0
  readonly stats: BodyMetrics = { delegate: 'loading', frames: 0, packets: 0, handPackets: 0, dropped: 0, trackingFps: 0, sentFps: 0, inferenceMs: 0, latencyP95Ms: 0, bytesPerSecond: 0, width: 0, height: 0, clock: 'presentation' }

  constructor(private video: HTMLVideoElement, private overlay: HTMLCanvasElement, private options: Options) { this.rate = options.fps ?? 30 }

  start() {
    if (this.live) return
    this.live = true; this.sampleAt = performance.now(); this.gen = this.options.generation()
    this.lastFrame = this.lastHand = -Infinity; this.lastVideo = this.pendingAt = -1
    this.rate = this.options.fps ?? 30; this.budget = new BodyBandwidth()
    this.options.loading?.(0)
    try {
      const worker = cameraWorker('body')
      this.worker = worker
      worker.onmessage = e => {
        if (!this.live || this.worker !== worker) return
        const m = e.data
        if (m.type === 'ready') {
          this.ready = true; this.stats.delegate = m.delegate; this.options.loading?.(null)
          if (this.fingers) worker.postMessage({ type: 'hands', hands: true })
        } else if (m.type === 'progress') this.options.loading?.(m.value)
        else if (m.type === 'result' && this.busy && m.at === this.pendingAt) {
          this.busy = false; this.stats.delegate = m.delegate
          this.result(m.result, m.at, m.capture, m.elapsed, m.hand)
        } else if (m.type === 'hands-error') {
          this.setFingers(false); this.options.fingersOff?.(); this.options.say(m.message)
        } else if (m.type === 'error') this.fail(m.message)
      }
      worker.onerror = () => { if (this.worker === worker) this.fail('Body tracking is unavailable. Close the camera and try again.') }
      worker.postMessage({ type: 'start' })
      this.schedule()
    } catch { this.fail('Body tracking is unavailable in this browser.') }
  }

  stop() {
    if (!this.live) return
    this.transmit(emptyBody(), performance.now(), true)
    this.setFingers(false)
    this.live = false; this.ready = false; this.busy = false
    this.worker?.terminate(); this.worker = null
    if (this.callback) this.video.cancelVideoFrameCallback(this.callback)
    cancelAnimationFrame(this.animation)
    this.signal.reset(); this.injected = null
    this.overlay.getContext('2d')?.clearRect(0, 0, this.overlay.width, this.overlay.height)
  }

  setFingers(enabled: boolean) {
    enabled = enabled && !!this.options.hand
    if (enabled === this.fingers) return
    if (!enabled) this.sendHand(null, performance.now(), true)
    this.fingers = enabled; this.handSide = ''; this.handFilter.reset()
    if (this.ready) this.worker?.postMessage({ type: 'hands', hands: enabled })
  }

  /** Exposed only behind the explicit loopback camera test switch by the caller. */
  injectForTest(body: BodyResult, hand?: HandLandmarkerResult) { this.injected = { body, hand } }

  private fail(text: string) { this.stop(); this.options.error?.(text); this.options.say(text) }

  private schedule() {
    if (!this.live) return
    if (this.video.requestVideoFrameCallback) {
      this.callback = this.video.requestVideoFrameCallback((at, meta) => {
        this.schedule(); this.stats.clock = meta.captureTime === undefined ? 'presentation' : 'capture'
        void this.frame(at, meta.captureTime ?? meta.presentationTime)
      })
    } else this.animation = requestAnimationFrame(at => {
      this.schedule()
      if (this.video.currentTime === this.lastVideo) return
      this.lastVideo = this.video.currentTime
      void this.frame(at, at)
    })
  }

  private async frame(at: number, capture: number) {
    if (!this.ready || this.busy || this.video.readyState < 2 || at - this.lastFrame < 1000 / this.rate - 1) return
    this.lastFrame = at
    const hands = this.fingers && at - this.lastHand >= 1000 / ((this.options.fps ?? 30) === 60 ? 10 : 30) - 1
    if (hands) this.lastHand = at
    if (this.injected) {
      this.stats.delegate = 'synthetic'
      this.result(this.injected.body, at, capture, 0, hands ? this.injected.hand : undefined)
      return
    }
    this.busy = true; this.pendingAt = at
    const worker = this.worker
    let bitmap: ImageBitmap | null = null
    try {
      bitmap = await createImageBitmap(this.video)
      if (!this.live || this.worker !== worker) { bitmap.close(); return }
      worker!.postMessage({ type: 'frame', frame: bitmap, at, capture, hands }, [bitmap])
      bitmap = null
    } catch { bitmap?.close(); if (this.worker === worker) this.busy = false }
  }

  private result(result: BodyResult, at: number, capture: number, cost: number, hand?: HandLandmarkerResult) {
    if (!Number.isFinite(capture) || !Number.isFinite(cost)) return
    if (performance.now() - capture >= 250) { this.signal.reset(); this.stats.dropped++; return }
    const sample = this.signal.sample(result, at)
    if (!sample) return
    this.stats.frames++; this.sampledFrames++
    this.costs.push(cost); if (this.costs.length > 120) this.costs.shift()
    if (sample.acquired) this.gen = this.options.generation()
    this.transmit(sample.body, capture)
    if (this.fingers && hand) this.sendHand(hand, capture)
    this.options.say(sample.body.flags ? (sample.body.presence[27] < .5 || sample.body.presence[28] < .5 ? 'Feet out of view · upper body' : '') : 'Step back until shoulders and hips are in view')
    this.draw(result, sample.body)
    if (performance.now() - this.sampleAt >= 1000) this.measure()
  }

  private time(capture: number) { return Math.round(Math.max(0, capture - this.options.timeOrigin) * 1000) >>> 0 }

  private transmit(body: BodySample, capture: number, force = false) {
    if (!force && !this.budget.take(performance.now())) { this.stats.dropped++; return }
    const packet = encodeBody({ ...body, t: this.time(capture), seq: this.options.sequence(), gen: this.gen })
    if (this.options.send(packet)) {
      this.stats.packets++; this.sampledPackets++; this.sampledBytes += BODY_BYTES
      this.latencies.push(Math.max(0, performance.now() - capture)); if (this.latencies.length > 120) this.latencies.shift()
    }
  }

  private sendHand(result: HandLandmarkerResult | null, capture: number, force = false) {
    const output = this.options.hand
    if (!output) return
    if (!force && !this.budget.take(performance.now(), 144)) { this.stats.dropped++; return }
    const w = result?.worldLandmarks?.[0], p = result?.landmarks?.[0], label = result?.handedness?.[0]?.[0]
    let valid = [w, p].every(a => a?.length === 21 && Array.from(a).every(v => v && [v.x, v.y, v.z].every(n => Number.isFinite(n) && Math.abs(n) <= 4)))
      && Number.isFinite(label?.score) && label!.score >= .7 && label!.score <= 1
      && (label?.categoryName === 'Left' || label?.categoryName === 'Right')
    let side = valid ? label!.categoryName : ''
    if (side !== this.handSide) { this.handGen = output.generation(); this.handFilter.reset(); this.handSide = side }
    const landmarks = valid ? this.handFilter.sample(w!.map(v => [v.x, -v.y, -v.z]), capture / 1000) : Array.from({ length: 21 }, (): Vec3 => [0, 0, 0])
    let position: Vec3 = valid ? palmPosition(landmarks, p!.map(v => [v.x, v.y, v.z]), this.video.videoWidth, this.video.videoHeight) : [0, 0, 0]
    if (position.some(n => !Number.isFinite(n) || Math.abs(n) > 16)) {
      valid = false; side = this.handSide = ''; position = [0, 0, 0]; this.handFilter.reset()
    }
    const state: HandState = {
      flags: valid ? HandFlag.tracked : 0, seq: output.sequence(), t: this.time(capture), gen: this.handGen,
      handedness: side === 'Left' ? 'left' : side === 'Right' ? 'right' : 'unknown', confidence: valid ? label!.score : 0,
      // Finger capture must never invoke the existing Hand-mode grab/orbit controls.
      gestures: 0, landmarks, p: position,
    }
    if (output.send(encodeHand(state))) { this.stats.handPackets++; this.sampledBytes += 144 }
  }

  private measure() {
    const now = performance.now(), seconds = (now - this.sampleAt) / 1000
    const latency = this.latencies.slice().sort((a, b) => a - b)
    Object.assign(this.stats, {
      trackingFps: this.sampledFrames / seconds, sentFps: this.sampledPackets / seconds, bytesPerSecond: this.sampledBytes / seconds,
      inferenceMs: this.costs.reduce((a, b) => a + b, 0) / Math.max(1, this.costs.length),
      latencyP95Ms: latency[Math.floor((latency.length - 1) * .95)] ?? 0, width: this.video.videoWidth, height: this.video.videoHeight,
    })
    this.options.metrics?.({ ...this.stats })
    this.sampleAt = now; this.sampledFrames = this.sampledPackets = this.sampledBytes = 0
    if (this.stats.delegate !== 'synthetic') {
      this.rate = Math.max(10, Math.min(this.options.fps ?? 30, Math.floor(1000 / Math.max(1, this.stats.inferenceMs * 1.25))))
      if (this.rate < 25 && this.video.videoWidth > 480 && now - this.resizedAt > 5000) {
        this.resizedAt = now
        void (this.video.srcObject as MediaStream | null)?.getVideoTracks()[0]?.applyConstraints({ width: { ideal: 480 }, height: { ideal: 360 } }).catch(() => {})
      }
    }
  }

  private draw(result: BodyResult, body: BodySample) {
    const c = this.overlay.getContext('2d'), points = result?.landmarks?.[0]
    if (!c) return
    const width = this.overlay.clientWidth || this.video.videoWidth, height = this.overlay.clientHeight || this.video.videoHeight
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    this.overlay.width = Math.round(width * dpr); this.overlay.height = Math.round(height * dpr)
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, width, height)
    if (this.overlay.dataset) this.overlay.dataset.lost = String(!body.flags)
    if (!body.flags || points?.length !== 33) return
    const scale = Math.min(width / this.video.videoWidth, height / this.video.videoHeight)
    const dw = this.video.videoWidth * scale, dh = this.video.videoHeight * scale
    const xy = (i: number) => ({ x: (width - dw) / 2 + (this.video.dataset.mirrored === 'true' ? 1 - points[i].x : points[i].x) * dw, y: (height - dh) / 2 + points[i].y * dh })
    c.strokeStyle = getComputedStyle(this.overlay).color; c.lineWidth = 2; c.lineCap = 'round'
    for (const chain of edges) for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1], b = chain[i]
      if (body.presence[a] < .5 || body.presence[b] < .5) continue
      const p = xy(a), q = xy(b)
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); c.stroke()
    }
  }
}
