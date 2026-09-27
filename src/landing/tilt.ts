/**
 * The phone's tilt for the home page, shared by the hero and the scenes: once a person switches it on (iOS asks, from
 * a tap), whatever is on screen follows how they tilt the phone. Readings are measured from however the phone is held
 * when it starts (or is recentred), turned to the screen's orientation, and lose a small deadzone, so a steady hand
 * reads as stillness. Only a real change (WAKE degrees) counts as a new gesture. There's no smoothing here: whatever
 * follows the tilt eases toward it every frame, so it always arrives where the phone points, even when the phone stops
 * sending new readings.
 */
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

const listeners = new Set<Listener>()
const s = { on: false, b0: NaN, g0: NaN, lb: 0, lg: 0, wb: 0, wg: 0 }
const soft = (v: number) => Math.sign(v) * Math.max(0, Math.abs(v) - DEAD)

function onOrient(e: DeviceOrientationEvent) {
  if (e.beta == null || e.gamma == null || document.hidden) return
  if (Number.isNaN(s.b0)) { s.b0 = s.lb = s.wb = e.beta; s.g0 = s.lg = s.wg = e.gamma; return }
  if (Math.abs(e.beta - s.lb) + Math.abs(e.gamma - s.lg) < JITTER) return
  s.lb = e.beta; s.lg = e.gamma
  let dx = e.gamma - s.g0, dy = e.beta - s.b0
  const a = screen.orientation?.angle ?? 0
  if (a === 90) [dx, dy] = [dy, -dx]
  else if (a === 270) [dx, dy] = [-dy, dx]
  else if (a === 180) [dx, dy] = [-dx, -dy]
  const wake = Math.abs(e.beta - s.wb) + Math.abs(e.gamma - s.wg) >= WAKE
  if (wake) { s.wb = e.beta; s.wg = e.gamma }
  for (const fn of listeners) fn({ x: soft(dx), y: soft(dy), wake })
}

/** Hear the tilt (once it's on). Returns a way to stop. */
export function onTilt(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** From now on, how the phone is held is level. */
export function recentre() { s.b0 = NaN; s.g0 = NaN }

/** Whether this browser has to ask first (iOS, and some Chrome builds), from a tap. */
export function asks(): boolean {
  const D = globalThis.DeviceOrientationEvent as (typeof DeviceOrientationEvent & { requestPermission?: unknown }) | undefined
  return !!D && typeof D.requestPermission === 'function'
}

export const tiltOn = () => s.on

/** Switch the tilt on (asking where the browser asks; call from a tap there). */
export async function startTilt(): Promise<boolean> {
  const D = globalThis.DeviceOrientationEvent as (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> }) | undefined
  if (!D) return false
  try { if (D.requestPermission && (await D.requestPermission()) !== 'granted') return false } catch { return false }
  if (!s.on) {
    s.on = true
    recentre()
    addEventListener('deviceorientation', onOrient)
    screen.orientation?.addEventListener?.('change', recentre)
    document.documentElement.classList.add('tilting')
  }
  return true
}
