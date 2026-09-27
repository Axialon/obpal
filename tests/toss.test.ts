import { describe, expect, it } from 'vitest'
import { TossDetector } from '@obpal/core'

const DT = 1 / 60
/** Accelerations along up (m/s²), each held for a number of samples; returns the tosses seen. */
function play(d: TossDetector, phases: [number, number][]) {
  const out: number[] = []
  for (const [a, n] of phases) for (let i = 0; i < n; i++) { const v = d.sample(a, DT); if (v !== null) out.push(v) }
  return out
}

describe('a toss', () => {
  it('is a flick up that brakes hard: it reports the speed the phone reached', () => {
    // 15 m/s² for 5 samples: about 1.2 m/s up (a little less, as the estimate forgets), then braking.
    const t = play(new TossDetector(), [[0, 10], [15, 5], [-15, 5], [0, 20]])
    expect(t.length).toBe(1)
    expect(t[0]).toBeGreaterThan(0.9)
    expect(t[0]).toBeLessThan(1.3)
  })
  it('a slow lift, a steady hand and a shake are not tosses', () => {
    expect(play(new TossDetector(), [[2, 30], [-2, 30]])).toEqual([])
    const d = new TossDetector()
    expect(play(d, Array.from({ length: 60 }, (_, i): [number, number] => [Math.sin(i) * 0.6, 1]))).toEqual([])
    // A shake: hard, but too quick to get going (a few ms each way).
    expect(play(new TossDetector(), [[20, 1], [-20, 1], [20, 1], [-20, 1]])).toEqual([])
  })
  it('a quick drop and catch is not a toss', () => {
    expect(play(new TossDetector(), [[-15, 5], [15, 5], [0, 20]])).toEqual([])
  })
  it('counts once per flick, not again on the way back down, and again for the next flick', () => {
    const d = new TossDetector()
    // Up and brake, back down and brake (the return), then another flick.
    const t = play(d, [[15, 5], [-15, 5], [-10, 5], [10, 5], [0, 10], [15, 5], [-15, 5], [0, 10]])
    expect(t.length).toBe(2)
  })
  it('keeps up with juggling, one toss per flick', () => {
    const d = new TossDetector()
    const flick: [number, number][] = [[14, 5], [-14, 5], [-8, 6], [8, 6]]
    expect(play(d, [...flick, ...flick, ...flick, ...flick]).length).toBe(4)
  })
  it('reads a motion event: up from gravity, whichever way the phone is held', () => {
    const d = new TossDetector()
    const tosses: number[] = []
    // Held tipped 40° toward the user; the flick is straight up in the world.
    const c = Math.cos((40 * Math.PI) / 180), s = Math.sin((40 * Math.PI) / 180)
    const up: [number, number, number] = [0, s, c]
    const at = (a: number) => {
      const accel: [number, number, number] = [0, up[1] * a, up[2] * a]
      const g: [number, number, number] = [accel[0] + up[0] * 9.81, accel[1] + up[1] * 9.81, accel[2] + up[2] * 9.81]
      const v = d.motion(accel, g, DT)
      if (v !== null) tosses.push(v)
    }
    for (const [a, n] of [[0, 10], [15, 5], [-15, 5], [0, 10]] as [number, number][]) for (let i = 0; i < n; i++) at(a)
    expect(tosses.length).toBe(1)
    // Without linear acceleration it still sees it, from accelerationIncludingGravity alone.
    const e = new TossDetector()
    let seen = 0
    for (const [a, n] of [[0, 60], [15, 5], [-15, 5], [0, 10]] as [number, number][]) {
      for (let i = 0; i < n; i++) if (e.motion(null, [up[0] * (9.81 + a), up[1] * (9.81 + a), up[2] * (9.81 + a)], DT) !== null) seen++
    }
    expect(seen).toBe(1)
  })
})
