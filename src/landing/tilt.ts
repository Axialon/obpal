/**
 * The phone's tilt for the home page, shared by the hero and the scenes: once a person switches it on (iOS asks, from
 * a tap), whatever is on screen follows how they tilt the phone. Readings are measured from however the phone is held
 * when it starts (or is recentred: the middle of its first few readings, so one stray reading can't set level askew),
 * decoded as W3C quaternions and measured against gravity, with a small deadzone for tray controls. A reading far off
 * both the one before it and the one after (a knock, a sensor's glitch) is let go: each reading counts as the middle of
 * the last three. Only a real change (WAKE degrees) counts as a new gesture. There's no other smoothing: whatever
 * follows the tilt eases toward it every frame, so it always arrives where the phone points, even when the phone stops
 * sending new readings. Exact turning has its own unfiltered quaternion listener: all three axes, unit gain and no
 * deadzone. Flicking the phone upward, screen level, is a toss (the hero's marble jumps).
 */
import { deviceScreenAngle, OrientationReference, phoneTiltAngles, qAxisAngle, qIdentity, qMul, quatFromDeviceOrientation, TossDetector, type Quat } from '@obpal/core'

export interface Tilt {
  /** Degrees from where it started: x + to the right, y + toward you. */
  x: number
  y: number
  /** A real tilt, not the drift of a steady hand. */
  wake: boolean
}
type Listener = (t: Tilt) => void

const JITTER = 0.35
const DEAD = 1.2
const WAKE = 3.5
/** Level is the middle of the readings in the first LEVEL_MS (ms) after the tilt starts, at most LEVEL_N of them. */
const LEVEL_MS = 120
const LEVEL_N = 7

const listeners = new Set<Listener>()
const turners = new Set<(q: Quat, generation: number) => void>()
const orientation = new OrientationReference()
let generation = 0
let reading: [number, number, number] | null = null
const tossers = new Set<(v: number) => void>()
const tosses = new TossDetector()
let motionAt = 0
const s = { on: false, ...tiltState() }
const soft = (v: number) => Math.sign(v) * Math.max(0, Math.abs(v) - DEAD)

/**
 * Where a reading is measured from (NaN: not yet; `first` gathers the readings that will set it), the last two readings
 * (the middle of three is the one that counts), and the last one heard and woken by.
 */
export function tiltState() { return { zero: null as Quat | null, screen: 0, lb: 0, lg: 0, wb: 0, wg: 0, first: [] as { q: Quat; at: number }[], last: [] as [number, number][] } }

const distance = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((s, v, i) => s + v * b[i], 0))))
/** Choose an actual sample nearest the others: no averaging Euler branches or antipodal quaternion components. */
const middle = (qs: Quat[]) => qs.reduce((best, q) => qs.reduce((s, p) => s + distance(p, q), 0) < qs.reduce((s, p) => s + distance(p, best), 0) ? q : best)
const mid = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))

/**
 * One reading of the phone's orientation (degrees), with the screen turned `angle`, at `at` (ms; NaN: unknown): the
 * tilt, or null while level is being set, or when it's a jitter of the last one. Pure, for tests: `st` carries it
 * from one to the next.
 */
export function readTilt(st: ReturnType<typeof tiltState>, beta: number, gamma: number, angle: number, at = NaN, alpha = 0): Tilt | null {
  const q = quatFromDeviceOrientation(alpha, beta, gamma, angle)
  if (st.screen !== angle) {
    const reframe = qAxisAngle(0, 0, 1, (st.screen - angle) * Math.PI / 180)
    if (st.zero) st.zero = qMul(st.zero, reframe)
    for (const sample of st.first) sample.q = qMul(sample.q, reframe)
  }
  st.screen = angle
  if (!st.zero) {
    // Level: the middle of the first readings, those within LEVEL_MS (at most LEVEL_N). A reading after that sets it
    // from those before, and then counts as a tilt.
    const t0 = st.first[0]?.at ?? at
    const late = st.first.length > 0 && at - t0 >= LEVEL_MS
    if (!late) st.first.push({ q, at })
    if (!late && st.first.length < LEVEL_N) return null
    st.zero = middle(st.first.map(r => r.q))
    st.last = [[0, 0], [0, 0]]
    st.first = []
    if (!late) return null
  }
  // The middle of the last three: a lone stray reading doesn't count; a real change does, a reading later.
  const angles = phoneTiltAngles(st.zero, q)
  const [p, prev] = st.last
  st.last = [prev, angles]
  const dx = mid(p[0], prev[0], angles[0]), dy = mid(p[1], prev[1], angles[1])
  if (Math.abs(dy - st.lb) + Math.abs(dx - st.lg) < JITTER) return null
  st.lb = dy; st.lg = dx
  const wake = Math.abs(dy - st.wb) + Math.abs(dx - st.wg) >= WAKE
  if (wake) { st.wb = dy; st.wg = dx }
  return { x: soft(dx), y: soft(dy), wake }
}

function onOrient(e: DeviceOrientationEvent) {
  if (e.beta == null || e.gamma == null || document.hidden || ![e.alpha ?? 0, e.beta, e.gamma].every(Number.isFinite)) return
  const angle = deviceScreenAngle()
  reading = [e.alpha ?? 0, e.beta, e.gamma]
  const q = orientation.relative(quatFromDeviceOrientation(...reading, angle), angle)
  for (const fn of turners) fn(q, generation)
  const t = readTilt(s, e.beta, e.gamma, angle, e.timeStamp, e.alpha ?? 0)
  if (t) for (const fn of listeners) fn(t)
}

function onMotion(e: DeviceMotionEvent) {
  const now = performance.now()
  const dt = motionAt ? Math.min(0.05, (now - motionAt) / 1000) : 1 / 60
  motionAt = now
  if (document.hidden || !tossers.size) return
  const a = e.acceleration, g = e.accelerationIncludingGravity
  const v = tosses.motion(a && a.x != null ? [a.x, a.y ?? 0, a.z ?? 0] : null, g && g.x != null ? [g.x, g.y ?? 0, g.z ?? 0] : null, dt)
  if (v !== null) for (const fn of tossers) fn(v)
}

/** Hear tosses (once the tilt is on): how fast the phone went up, m/s. Returns a way to stop. */
export function onToss(fn: (v: number) => void): () => void {
  tossers.add(fn)
  return () => tossers.delete(fn)
}

/** Hear the tilt (once it's on). Returns a way to stop. */
export function onTilt(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Exact, unscaled rotation about camera right, up and toward the viewer; a steady reading remains in charge. */
export function onOrientation(fn: (q: Quat, generation: number) => void): () => void {
  turners.add(fn)
  return () => turners.delete(fn)
}

/** From now on, how the phone is held is level. */
export function recentre() {
  Object.assign(s, tiltState()); orientation.reset(); generation++
  // A stationary sensor need not send another event: the first subsequent turn must already count.
  if (reading) {
    const angle = deviceScreenAngle()
    orientation.capture(quatFromDeviceOrientation(...reading, angle), angle)
    for (const fn of turners) fn(qIdentity(), generation)
  }
}

/** Whether this browser has to ask first (iOS, and some Chrome builds), from a tap. */
export function asks(): boolean {
  const D = globalThis.DeviceOrientationEvent as (typeof DeviceOrientationEvent & { requestPermission?: unknown }) | undefined
  return !!D && typeof D.requestPermission === 'function'
}

export const tiltOn = () => s.on

/** Switch the tilt on (asking where the browser asks; call from a tap there). */
export async function startTilt(): Promise<boolean> {
  type Asks = { requestPermission?: () => Promise<string> }
  const D = globalThis.DeviceOrientationEvent as (typeof DeviceOrientationEvent & Asks) | undefined
  const M = globalThis.DeviceMotionEvent as (typeof DeviceMotionEvent & Asks) | undefined
  if (!D) return false
  // Both questions from the same tap (iOS answers them together; asking after an await would be too late).
  try {
    const asked = [D.requestPermission?.(), M?.requestPermission?.()].filter(Boolean) as Promise<string>[]
    if ((await Promise.all(asked)).some((r) => r !== 'granted')) return false
  } catch { return false }
  if (!s.on) {
    s.on = true
    recentre()
    addEventListener('deviceorientation', onOrient)
    addEventListener('devicemotion', onMotion)
    document.documentElement.classList.add('tilting')
  }
  return true
}
