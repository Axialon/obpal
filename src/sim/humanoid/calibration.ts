/** Only derived radians and segment lengths are serialised; camera samples stay in memory. */
import { clamp, rad, type Angles, type RigProfile } from './profile'
export interface Calibration {
  v: 1
  profile: string
  ranges: Record<string, [number, number]>
  lengths: Record<string, number>
}
export const CALIBRATION_KEY = 'obpal.humanoid.calibration.v1.'
export const freshCalibration = (p: RigProfile): Calibration => ({
  v: 1,
  profile: p.calibrationId ?? p.id,
  ranges: {},
  lengths: {},
})
export function mapRange(value: number, user: readonly [number, number], robot: readonly [number, number]) {
  if (!Number.isFinite(value)) return clamp(0, ...robot)
  if (!user.every(Number.isFinite) || user[1] - user[0] < rad(5)) return clamp(value, ...robot)
  return clamp(robot[0] + clamp((value - user[0]) / (user[1] - user[0]), 0, 1) * (robot[1] - robot[0]), ...robot)
}
export function applyRanges(p: RigProfile, q: Angles, data: Calibration): Angles {
  return Object.fromEntries(
    p.joints.map((j) => [
      j.id,
      data.ranges[j.id] ? mapRange(q[j.id], data.ranges[j.id], j.limits) : clamp(q[j.id] || 0, ...j.limits),
    ]),
  )
}
export function parseCalibration(raw: string | null, p: RigProfile): Calibration {
  const clean = freshCalibration(p)
  try {
    const data = JSON.parse(raw ?? 'null')
    if (data?.v !== 1 || data.profile !== clean.profile) return clean
    for (const j of p.joints) {
      const r = data.ranges?.[j.id]
      if (
        Array.isArray(r) &&
        r.length === 2 &&
        r.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= Math.PI * 2) &&
        r[1] - r[0] >= rad(5)
      )
        clean.ranges[j.id] = [r[0], r[1]]
    }
    for (const chain of p.chains)
      for (const suffix of ['upper', 'lower']) {
        const key = `${chain.id}.${suffix}`,
          n = data.lengths?.[key]
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0.08 && n <= 1) clean.lengths[key] = n
      }
  } catch {
    /* Missing or incompatible calibration uses the uncalibrated ranges. */
  }
  return clean
}
export interface CalibrationStep {
  id: string
  name: string
  cue: string
  joints: string[]
}
export function calibrationSteps(p: RigProfile): CalibrationStep[] {
  const matching = (s: string) => p.joints.filter((j) => j.id.includes(s)).map((j) => j.id)
  return [
    {
      id: 'shoulders',
      name: 'Shoulders',
      cue: 'Raise, reach forward, then out',
      joints: p.chains.filter((c) => c.group === 'arms').flatMap((c) => c.joints.slice(0, 3)),
    },
    { id: 'elbows', name: 'Elbows', cue: 'Bend and straighten', joints: matching('.elbow') },
    { id: 'wrists', name: 'Wrists', cue: 'Turn, bend and sweep your hands', joints: matching('.wrist.') },
    { id: 'spine', name: 'Spine', cue: 'Turn, then lean each way', joints: [...(p.frame?.spine ?? [])] },
    {
      id: 'hips',
      name: 'Hips',
      cue: 'Lift, open and turn each leg',
      joints: p.chains.filter((c) => c.group === 'legs').flatMap((c) => c.joints.slice(0, 3)),
    },
    { id: 'knees', name: 'Knees', cue: 'Bend and straighten each knee', joints: matching('.knee') },
    { id: 'ankles', name: 'Ankles', cue: 'Point, flex and roll each foot', joints: matching('.ankle.') },
    { id: 'head', name: 'Head', cue: 'Look left, right, up and down', joints: [...(p.frame?.head ?? [])] },
  ].filter((s) => s.joints.length)
}
export class RangeWalkthrough {
  readonly steps: CalibrationStep[]
  index = 0
  active = false
  done = new Set<string>()
  skipped = new Set<string>()
  private observed: Record<string, [number, number]> = {}
  constructor(
    readonly profile: RigProfile,
    public data: Calibration,
  ) {
    this.steps = calibrationSteps(profile)
  }
  get step() {
    return this.steps[this.index]
  }
  start(index = 0) {
    this.index = clamp(index, 0, this.steps.length - 1)
    this.observed = {}
    this.active = true
  }
  sample(q: Angles, valid: ReadonlySet<string>) {
    if (!this.active) return
    for (const id of this.step.joints)
      if (valid.has(id) && Number.isFinite(q[id])) {
        const r = this.observed[id]
        this.observed[id] = r ? [Math.min(r[0], q[id]), Math.max(r[1], q[id])] : [q[id], q[id]]
      }
  }
  get progress() {
    const ranges = this.step.joints.map((id) => this.observed[id]).filter(Boolean)
    return ranges.length ? Math.max(...ranges.map((r) => clamp((r[1] - r[0]) / rad(45), 0, 1))) : 0
  }
  complete() {
    let count = 0
    for (const id of this.step.joints) {
      const r = this.observed[id]
      if (r && r[1] - r[0] >= rad(5)) {
        this.data.ranges[id] = [...r]
        count++
      }
    }
    if (!count) return false
    this.done.add(this.step.id)
    this.skipped.delete(this.step.id)
    this.advance()
    return true
  }
  skip() {
    this.skipped.add(this.step.id)
    this.advance()
  }
  redo(index = this.index) {
    const step = this.steps[index]
    for (const id of step.joints) delete this.data.ranges[id]
    this.done.delete(step.id)
    this.skipped.delete(step.id)
    this.start(index)
  }
  private advance() {
    if (this.index === this.steps.length - 1) this.active = false
    else this.start(this.index + 1)
  }
}
