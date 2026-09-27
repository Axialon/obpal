/**
 * Camera tracking for phones that can't track themselves (iPhones: no WebXR), the way PlayStation Move works: the
 * phone's screen glows in its seat colour, and this computer's camera finds that colour. Where the glow is in the
 * picture gives left, right, up and down; how big it looks gives the distance. A touch on the glowing screen is the
 * deadman, as on the other modes. A GlowFollower turns each glowing phone's move into a pose (Frame.pose), so a
 * host drives what they hold exactly as it does for a phone that tracks itself (mode 6).
 */
import { Mode } from '@obpal/core'
import type { Frame } from './stream'

/** Hue (degrees), saturation and value (0–1) of an RGB colour. */
export function hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, max ? d / max : 0, max / 255]
}

export const hueOf = (hex: string) => {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16)
  return hsv((n >> 16) & 255, (n >> 8) & 255, n & 255)[0]
}

export interface Blob { x: number; y: number; n: number }

/**
 * The glow of hue `hue` in an RGBA image: its centre (pixels) and size (pixel count), or null if it isn't there.
 * Bright, saturated pixels within `tol` degrees count.
 */
export function findBlob(px: Uint8ClampedArray, w: number, h: number, hue: number, tol = 16, min = 10): Blob | null {
  let n = 0
  let sx = 0
  let sy = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const [hh, s, v] = hsv(px[i], px[i + 1], px[i + 2])
      if (s < 0.4 || v < 0.45) continue
      const dh = Math.abs(((hh - hue + 540) % 360) - 180)
      if (dh > tol) continue
      n++
      sx += x
      sy += y
    }
  }
  return n >= min ? { x: sx / n, y: sy / n, n } : null
}

/**
 * A glow's move since it was anchored, in metres, in the hand's frame (right, up, toward the screen), assuming the
 * phone was about `d0` from the camera when the thumb went down and the camera sees about 60° across. The camera faces
 * the person, so their right is the picture's left.
 */
export function glowMove(a: Blob, b: Blob, w: number, _h: number, d0 = 0.6): { right: number; up: number; forward: number } {
  const d = d0 * Math.sqrt(a.n / Math.max(1, b.n))
  const perPx = (2 * Math.tan(30 * Math.PI / 180)) / w
  return {
    right: -(b.x - a.x) * perPx * d,
    up: -(b.y - a.y) * perPx * d,
    forward: d0 - d,
  }
}

/** This computer's camera, sampled small and often. */
export class GlowCamera {
  readonly video = document.createElement('video')
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  private stream: MediaStream | null = null
  readonly w = 160
  readonly h = 120
  image: ImageData | null = null

  constructor() {
    this.canvas.width = this.w
    this.canvas.height = this.h
    this.video.muted = true
    this.video.playsInline = true
  }

  get on() { return !!this.stream }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false })
    this.video.srcObject = this.stream
    await this.video.play()
    await this.darken()
  }

  /**
   * Where the camera lets a page set it, expose darker, as PlayStation Move's camera does: a phone's glow stays
   * coloured instead of burning to white, and the room falls away.
   */
  private async darken() {
    const track = this.stream?.getVideoTracks()[0]
    type Range = { min: number; max: number }
    const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { exposureCompensation?: Range }) | undefined
    const ec = caps?.exposureCompensation
    if (!track || !ec || !(ec.min < 0)) return
    try { await track.applyConstraints({ advanced: [{ exposureCompensation: ec.min / 2 } as MediaTrackConstraintSet] }) } catch { /* the camera said no */ }
  }

  stop() {
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.stream = null
    this.video.srcObject = null
    this.image = null
  }

  /** Grab the current picture (small). */
  sample(): ImageData | null {
    if (!this.stream || this.video.readyState < 2) return null
    this.ctx.drawImage(this.video, 0, 0, this.w, this.h)
    this.image = this.ctx.getImageData(0, 0, this.w, this.h)
    return this.image
  }
}

interface Glow { anchor: Blob | null; last: Blob | null; gen: number; unseenSince: number; toldAt: number }
export type Pose = NonNullable<Frame['pose']>

/** Follows glowing phones with this computer's camera, and gives each a pose while its deadman is held. */
export class GlowFollower {
  readonly cam = new GlowCamera()
  private glows = new Map<string, Glow>()
  private at = 0
  /** A held glow the camera can't find (called at most every 4 s per phone). */
  onUnseen?: (id: string) => void
  /** Someone glows, but the camera is off (called at most every 5 s). */
  onCameraOff?: () => void
  private offToldAt = 0

  /**
   * Once a frame: poses for the phones glowing in 3D (mode 6 with no pose of their own), by participant id. Others
   * get none, so their frames pass through as they are.
   */
  step(now: number, people: { id: string; color: string; frame: Frame }[]): Map<string, Pose> {
    const out = new Map<string, Pose>()
    const img = this.cam.on && now - this.at > 30 ? this.cam.sample() : null
    if (img) this.at = now
    for (const { id, color, frame: f } of people) {
      if (f.mode !== Mode.track || f.pose) { this.glows.delete(id); continue }
      if (!this.cam.on) {
        if (f.touching && now - this.offToldAt > 5000) { this.offToldAt = now; this.onCameraOff?.() }
        continue
      }
      const g = this.glows.get(id) ?? { anchor: null, last: null, gen: 0, unseenSince: 0, toldAt: 0 }
      this.glows.set(id, g)
      if (img) {
        const b = findBlob(img.data, this.cam.w, this.cam.h, hueOf(color || '#c6ff34'))
        g.last = b && g.last ? { x: g.last.x + (b.x - g.last.x) * 0.6, y: g.last.y + (b.y - g.last.y) * 0.6, n: g.last.n + (b.n - g.last.n) * 0.4 } : b
      }
      if (!f.touching) { g.anchor = null; g.unseenSince = 0; continue }
      if (!g.last) {
        g.unseenSince ||= now
        if (now - g.unseenSince > 1000 && now - g.toldAt > 4000) { g.toldAt = now; this.onUnseen?.(id) }
      } else g.unseenSince = 0
      if (!g.anchor && g.last) { g.anchor = { ...g.last }; g.gen = (g.gen + 1) & 0xff }
      if (!g.anchor) continue
      const m = g.last ? glowMove(g.anchor, g.last, this.cam.w, this.cam.h) : null
      out.set(id, { p: m ? [m.right, m.up, -m.forward] : [0, 0, 0], q: [0, 0, 0, 1], tracked: !!m, touching: f.touching, gen: g.gen })
    }
    return out
  }

  /** Draw what the camera sees, with each glow circled in its phone's colour. */
  draw(ctx: CanvasRenderingContext2D, colorOf: (id: string) => string) {
    const img = this.cam.image
    if (!img) return
    ctx.putImageData(img, 0, 0)
    for (const [id, g] of this.glows) {
      if (!g.last) continue
      ctx.strokeStyle = colorOf(id) || '#ffffff'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(g.last.x, g.last.y, Math.sqrt(g.last.n / Math.PI) + 4, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}
