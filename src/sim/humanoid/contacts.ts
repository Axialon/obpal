/** Host-authoritative practice contacts. Scoring is a mode, separate from motion. */
import { Vector3 } from 'three'
import { clamp } from './profile'
export enum PracticeMode {
  Practice = 'practice',
  Free = 'free',
}
export interface ContactActor {
  id: string
  chest: Vector3
  pelvis: Vector3
  fists: Vector3[]
  elbows: Vector3[]
  shoulders: Vector3[]
  blocked: boolean
}
export interface Hit {
  from: string
  to: string
  at: Vector3
  blocked: boolean
  speed: number
}
/** Closest separation of two finite segments, including parallel and zero-length cases. */
export function segmentDistance(a: Vector3, b: Vector3, c: Vector3, d: Vector3) {
  const u = b.clone().sub(a),
    w = a.clone().sub(c),
    v = d.clone().sub(c)
  const A = u.dot(u),
    B = u.dot(v),
    C = v.dot(v),
    D = u.dot(w),
    E = v.dot(w),
    den = A * C - B * B
  let s = den > 1e-10 ? clamp((B * E - C * D) / den, 0, 1) : 0
  let t = C > 1e-10 ? (B * s + E) / C : 0
  if (t < 0) {
    t = 0
    s = A > 1e-10 ? clamp(-D / A, 0, 1) : 0
  } else if (t > 1) {
    t = 1
    s = A > 1e-10 ? clamp((B - D) / A, 0, 1) : 0
  }
  return a.clone().addScaledVector(u, s).distanceTo(c.clone().addScaledVector(v, t))
}
export class Contacts {
  mode = PracticeMode.Practice
  scores: Record<string, number> = {}
  private last = new Map<string, { p: Vector3; relative: Vector3; hit: boolean; at: number }>()
  reset() {
    this.last.clear()
    this.scores = {}
  }
  resetMotion() {
    this.last.clear()
  }
  step(actors: ContactActor[], dt: number, now: number): Hit[] {
    const hits: Hit[] = []
    for (const a of actors)
      a.fists.forEach((f, i) => {
        const key = `${a.id}:${i}`,
          old = this.last.get(key)
        const relative = f.clone().sub(a.shoulders[i])
        if (!old) {
          this.last.set(key, { p: f.clone(), relative, hit: false, at: -Infinity })
          return
        }
        // Walking into another actor is not a punch. Measure the stroke relative to its own shoulder.
        const speed = relative.distanceTo(old.relative) / Math.max(0.001, dt)
        if ((relative.length() < 0.36 || relative.y < -0.3) && speed < 0.4) old.hit = false
        if (!old.hit && speed > 0.4 && speed < 8 && now - old.at >= 0.15)
          for (const b of actors) {
            if (a.id === b.id) continue
            const guard = b.blocked && b.fists.some((g, j) => segmentDistance(old.p, f, b.elbows[j], g) < 0.18)
            const torso = segmentDistance(old.p, f, b.pelvis, b.chest) < 0.3
            if (!guard && !torso) continue
            old.hit = true
            old.at = now
            if (!guard && this.mode === PracticeMode.Practice) this.scores[a.id] = (this.scores[a.id] ?? 0) + 1
            hits.push({ from: a.id, to: b.id, at: f.clone(), blocked: guard, speed })
            break
          }
        old.p.copy(f)
        old.relative.copy(relative)
      })
    return hits
  }
}
