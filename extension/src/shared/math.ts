/** Small numeric helpers shared by the key and 3D mappers. Pure. */

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Two-threshold switch: turns on at `press`, and once on stays on until the value drops below `release`.
 * Keeps keys from chattering when a stick rests near the threshold.
 */
export const hysteresis = (on: boolean, value: number, press: number, release: number) =>
  on ? value >= release : value >= press

/** Stick response: a per-axis deadzone, the rest rescaled to 0..1, then an exponent curve (1 = linear). */
export function stickCurve(v: number, deadzone: number, expo = 1): number {
  const a = Math.abs(v)
  if (!(a > deadzone)) return 0
  const n = Math.min(1, (a - deadzone) / (1 - deadzone))
  return Math.sign(v) * Math.pow(n, expo)
}

/**
 * Sub-pixel accumulator: feeds fractional motion in and hands out whole pixels, keeping the remainder,
 * so slow motion still moves (0.4 px per frame becomes 1 px every 2 to 3 frames) and nothing is lost.
 */
export class Accum {
  private r: [number, number] = [0, 0]

  take(dx: number, dy: number): [number, number] {
    this.r[0] += dx
    this.r[1] += dy
    const ix = Math.trunc(this.r[0])
    const iy = Math.trunc(this.r[1])
    this.r[0] -= ix
    this.r[1] -= iy
    return [ix, iy]
  }

  reset() {
    this.r = [0, 0]
  }
}

/** A controller snapshot in the W3C standard layout: +Y is down, triggers 0..1. */
export interface PadInput {
  buttons: number
  axes: readonly [number, number, number, number]
  triggers: readonly [number, number]
}

/** Is standard button `i` held? Triggers (6, 7) also count their analog value. */
export function buttonValue(pad: PadInput, i: number): number {
  const bit = pad.buttons & (1 << i) ? 1 : 0
  if (i === 6) return Math.max(bit, pad.triggers[0])
  if (i === 7) return Math.max(bit, pad.triggers[1])
  return bit
}
