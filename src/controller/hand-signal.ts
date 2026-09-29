/** Low-lag camera signals. Distances are metres; timestamps are monotonic seconds. */
import type { Vec3 } from '@obpal/core'

export class OneEuro {
  private at = -1
  private raw = 0
  private value = 0
  private speed = 0
  constructor(private minCutoff = 1.5, private beta = 35, private derivativeCutoff = 2) {}
  reset() { this.at = -1 }
  sample(value: number, at: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(at)) return this.value
    if (this.at >= 0 && at <= this.at) return this.value
    if (this.at < 0 || at - this.at > .25) {
      this.at = at; this.raw = value; this.value = value; this.speed = 0
      return value
    }
    const dt = at - this.at
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt))
    this.speed += alpha(this.derivativeCutoff) * ((value - this.raw) / dt - this.speed)
    this.value += alpha(this.minCutoff + this.beta * Math.abs(this.speed)) * (value - this.value)
    this.at = at; this.raw = value
    return this.value
  }
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** Separate enter/leave thresholds prevent a near-boundary hand from clicking repeatedly. */
export class HandGestures {
  private bits = 0
  private enters = [0, 0, 0]
  private rises = [0, 0]
  private previous = [Infinity, Infinity]
  reset() { this.bits = 0; this.enters.fill(0); this.rises.fill(0); this.previous.fill(Infinity) }
  sample(p: Vec3[]): number {
    if (p.length !== 21) { this.reset(); return 0 }
    const width = Math.max(.02, distance(p[5], p[17]))
    const pinch = distance(p[4], p[8]) / width
    const fingers = [5, 9, 13, 17].map(i => distance(p[i + 3], p[0]) / Math.max(.015, distance(p[i], p[0])))
    const grip = fingers.reduce((a, b) => a + b, 0) / 4
    const ratios = [pinch, grip]
    let bits = 0
    for (let i = 0; i < 3; i++) {
      const bit = 1 << i, held = !!(this.bits & bit)
      let keep: boolean
      if (i < 2) {
        const ratio = ratios[i]
        this.rises[i] = ratio > this.previous[i] ? this.rises[i] + 1 : 0
        this.previous[i] = ratio
        keep = ratio < (held ? [.42, 1.65][i] : [.28, 1.35][i])
        if (held && ratio > [.35, 1.5][i] && this.rises[i] >= 3) keep = false
      } else keep = fingers[0] > (held ? 1.8 : 2.1) && fingers.slice(1).every(n => n < (held ? 2 : 1.8))
      this.enters[i] = keep ? this.enters[i] + 1 : 0
      if (keep && (held || this.enters[i] >= 2)) bits |= bit
    }
    // A curled index and thumb are a fist, even when their tips happen to touch.
    this.bits = bits & 2 ? 2 : bits & 1 ? 1 : bits
    return this.bits
  }
}

/** 18 kB/s of HAND payload, reserving 2 kB/s for state within the 20 kB/s budget. At most two frames in a burst. */
export class HandBandwidth {
  private tokens = 288
  private at = 0
  take(now: number): boolean {
    this.tokens = Math.min(288, this.tokens + Math.max(0, now - this.at) * 18)
    this.at = now
    if (this.tokens < 144) return false
    this.tokens -= 144
    return true
  }
}

/**
 * Monocular translation from palm size and a nominal 60 degree horizontal field of view. This is a relative
 * control estimate, not camera calibration or world tracking. The model's 21 world landmarks stay hand-centred.
 */
export function palmPosition(world: Vec3[], image: Vec3[], width: number, height: number): Vec3 {
  const focal = width / (2 * Math.tan(Math.PI / 6))
  const estimate = (a: number, b: number) => {
    const pixels = Math.hypot((image[a][0] - image[b][0]) * width, (image[a][1] - image[b][1]) * height)
    const span = distance(world[a], world[b])
    return span < .015 || pixels < 8 ? Infinity : focal * span / pixels
  }
  const depth = Math.max(.15, Math.min(2.5, estimate(5, 17), estimate(0, 9)))
  const centre = [0, 5, 9, 13, 17].reduce((p, i) => [p[0] + image[i][0] / 5, p[1] + image[i][1] / 5], [0, 0])
  return [(centre[0] - .5) * width * depth / focal, (.5 - centre[1]) * height * depth / focal, -depth]
}

/** One independent filter for every axis; reset on every new hand or tracking origin. */
export class LandmarkFilter {
  private filters = Array.from({ length: 63 }, () => new OneEuro())
  reset() { this.filters.forEach(f => f.reset()) }
  sample(points: Vec3[], at: number): Vec3[] {
    return points.map((p, i) => p.map((n, axis) => this.filters[i * 3 + axis].sample(n, at)) as Vec3)
  }
}
