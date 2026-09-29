import { BODY_BYTES, BODY_POINTS, BodyFlag, type BodyState, type Vec3 } from '@obpal/core'
import { OneEuro } from './hand-signal'

export interface BodyPoint { x: number; y: number; z: number; visibility?: number; presence?: number }
export interface BodyResult { landmarks: BodyPoint[][]; worldLandmarks: BodyPoint[][] }
export type BodySample = Pick<BodyState, 'flags' | 'landmarks' | 'visibility' | 'presence'>
export const emptyBody = (): BodySample => ({ flags: 0, landmarks: Array.from({ length: BODY_POINTS }, () => [0, 0, 0]), visibility: Array(BODY_POINTS).fill(0), presence: Array(BODY_POINTS).fill(0) })
export const BODY_ENTER = .7, BODY_LEAVE = .5, BODY_ACQUIRE_FRAMES = 3

/** One shared camera allowance, leaving 2 kB/s for neutral STATE and held controls. */
export class BodyBandwidth {
  private tokens = BODY_BYTES * 2
  private at = 0
  take(now: number, bytes = BODY_BYTES) {
    this.tokens = Math.min(BODY_BYTES * 2, this.tokens + Math.max(0, now - this.at) * 18)
    this.at = now
    if (this.tokens < bytes) return false
    this.tokens -= bytes
    return true
  }
}

const finite = (p: BodyPoint | undefined) => !!p && [p.x, p.y, p.z].every(n => Number.isFinite(n) && Math.abs(n) <= 8)
const score = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0
const torso = [11, 12, 23, 24]

/** Camera axes stay anatomical; preview mirroring never changes transmitted points. */
export class BodySignal {
  private filters = Array.from({ length: BODY_POINTS }, () => [new OneEuro(), new OneEuro(), new OneEuro()])
  private tracked = false
  private enters = 0
  private at = -1
  private previous: Vec3[] | null = null

  reset() {
    this.filters.forEach(fs => fs.forEach(f => f.reset()))
    this.tracked = false; this.enters = 0; this.at = -1; this.previous = null
  }

  sample(result: BodyResult, at: number): { body: BodySample; acquired: boolean } | null {
    if (!Number.isFinite(at) || at <= this.at) return null
    if (this.at >= 0 && at - this.at >= 250) this.reset()
    this.at = at
    const body = emptyBody(), world = result?.worldLandmarks?.[0], image = result?.landmarks?.[0]
    const complete = world?.length === BODY_POINTS && image?.length === BODY_POINTS
    if (complete) for (let i = 0; i < BODY_POINTS; i++) {
      const w = world[i], p = image[i]
      if (!finite(w) || !finite(p) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) { this.filters[i].forEach(f => f.reset()); continue }
      const visibility = Math.min(score(w.visibility), score(p.visibility))
      // Tasks Vision 1.0.1 omits per-point presence in JS. Never invent a higher confidence than visibility.
      body.visibility[i] = visibility
      body.presence[i] = Math.min(visibility, score(p.presence ?? visibility), score(w.presence ?? visibility))
      const point: Vec3 = [w.x, -w.y, -w.z]
      body.landmarks[i] = point
    }
    const confidence = Math.min(...torso.map(i => Math.min(body.visibility[i], body.presence[i])))
    const jumped = this.previous && torso.some(i => Math.hypot(...body.landmarks[i].map((n, a) => n - this.previous![i][a])) > .45)
    const was = this.tracked
    if (confidence < BODY_LEAVE || jumped) {
      this.tracked = false; this.enters = 0
      this.filters.forEach(fs => fs.forEach(f => f.reset()))
    } else if (!this.tracked) {
      this.enters = confidence >= BODY_ENTER ? this.enters + 1 : 0
      this.tracked = this.enters >= BODY_ACQUIRE_FRAMES
    }
    this.previous = confidence >= BODY_LEAVE ? body.landmarks.map(p => [...p]) : null
    if (this.tracked) body.flags = BodyFlag.tracked
    for (let i = 0; i < BODY_POINTS; i++) {
      if (body.presence[i] < BODY_LEAVE) { this.filters[i].forEach(f => f.reset()); continue }
      body.landmarks[i] = body.landmarks[i].map((n, a) => this.filters[i][a].sample(n, at / 1000)) as Vec3
    }
    return { body, acquired: !was && this.tracked }
  }
}
