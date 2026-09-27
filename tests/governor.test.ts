import { describe, expect, it } from 'vitest'
import { BUDGET, glassScale, Governor, HI_MS, ladder, LO_MS, median, pick, SLOW } from '../src/landing/governor'

/** Frames drawn at `level`'s cost: n of them, dt apart (s), each timed by the GPU at `ms` (or not timed: null). */
function run(g: Governor, n: number, frame: (level: number) => { dt: number; ms: number | null }) {
  const seen: number[] = []
  for (let i = 0; i < n; i++) {
    const { dt, ms } = frame(g.level)
    g.frame(dt, ms === null ? null : { ms, level: g.level })
    if (seen.at(-1) !== g.level) seen.push(g.level)
  }
  return seen
}

describe('the quality ladder', () => {
  it('on a computer at one pixel per CSS pixel: twice the pixels first, then 1.5, then the glass goes; never under the screen', () => {
    expect(ladder(1, false)).toEqual([{ pr: 2, glass: 2 }, { pr: 1.5, glass: 2 }, { pr: 1, glass: 2 }, { pr: 1, glass: 1 }, { pr: 1, glass: 0 }])
  })
  it('on a dense screen the extra pixels are already there: the glass goes first, the resolution last', () => {
    expect(ladder(2, false)).toEqual([{ pr: 2, glass: 2 }, { pr: 2, glass: 1 }, { pr: 2, glass: 0 }, { pr: 1.5, glass: 0 }, { pr: 1, glass: 0 }])
    const l = ladder(1.25, false)
    expect(l[0]).toEqual({ pr: 2, glass: 2 })
    expect(l.findIndex((s) => s.pr < 1.25)).toBe(l.length - 1)
  })
  it('names its steps for ?quality=: super, native, lite, plain, low (or a number)', () => {
    const l = ladder(1, false)
    expect(['super', 'native', 'lite', 'plain', 'low', '9', 'sharpest'].map((n) => pick(l, n))).toEqual([0, 2, 3, 4, 4, 4, -1])
    // On a dense screen the finest step is its own pixels.
    const d = ladder(2, false)
    expect(['super', 'native', 'lite', 'plain', 'low'].map((n) => pick(d, n))).toEqual([0, 0, 1, 2, 4])
  })
  it('a phone draws at most 2 pixels per CSS pixel, and never more than it has', () => {
    expect(ladder(3, true)[0]).toEqual({ pr: 2, glass: 2 })
    expect(ladder(1, true)).toEqual([{ pr: 1, glass: 2 }, { pr: 1, glass: 1 }, { pr: 1, glass: 0 }])
  })
})

describe('the pixel budget', () => {
  const top = (dpr: number, w: number, h: number) => ladder(dpr, false, { w, h })[0].pr
  it('lets a canvas the size of a 1080p screen draw twice its pixels, a 1440p one about 1.5 times, a 4K one none extra', () => {
    expect(top(1, 1920, 1080)).toBe(2)
    expect(top(1, 2560, 1440)).toBe(1.5)
    expect(ladder(1, false, { w: 3840, h: 2160 })).toEqual([{ pr: 1, glass: 2 }, { pr: 1, glass: 1 }, { pr: 1, glass: 0 }])
  })
  it("the home page's hero (900 CSS px tall on a big screen): 2x at 1920 wide, a little less at 2560, 1.54x at 3840", () => {
    expect(top(1, 1920, 900)).toBe(2)
    expect(top(1, 2560, 900)).toBe(1.89)
    expect(top(1, 3840, 900)).toBe(1.54)
  })
  it('never draws more than BUDGET pixels above the screen\'s own, and never fewer than the screen\'s own', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      for (const [w, h] of [[800, 600], [1366, 768], [1920, 900], [2560, 1440], [3440, 1440], [3840, 2160], [7680, 4320]]) {
        const l = ladder(dpr, false, { w, h })
        const native = Math.min(dpr, 3)
        for (const s of l.filter((x) => x.pr > native)) expect(s.pr ** 2 * w * h).toBeLessThanOrEqual(BUDGET)
        // The screen's own pixels are always on the ladder, with all the glass, however big the screen.
        expect(l).toContainEqual({ pr: native, glass: 2 })
      }
    }
  })
  it('only the steps above the screen\'s own are held back: below them the ladder is the same', () => {
    const free = ladder(1.5, false), held = ladder(1.5, false, { w: 3840, h: 2160 })
    expect(held.slice(held.findIndex((s) => s.pr === 1.5 && s.glass === 2))).toEqual(free.slice(free.findIndex((s) => s.pr === 1.5 && s.glass === 2)))
    expect(held[0].pr).toBe(1.5)
  })
  it('a phone is unchanged by it', () => {
    expect(ladder(3, true, { w: 390, h: 844 })).toEqual(ladder(3, true))
  })
  it('the picture behind the glass follows the drawing buffer: half its pixels at most, never above half the screen\'s own', () => {
    for (const dpr of [1, 1.25, 2, 3]) {
      for (const [w, h] of [[1920, 900], [3840, 900], [3840, 2160]]) {
        for (const s of ladder(dpr, false, { w, h })) {
          const k = glassScale(s, dpr)
          expect(k).toBeLessThanOrEqual(s.pr / 2 + 1e-9)
          expect(k).toBeLessThanOrEqual(Math.min(dpr, 2) / 2 + 1e-9)
          if (s.glass === 0) expect(k).toBe(0)
        }
      }
    }
    // At 3840 x 900 CSS px at 1x, the finest step draws 5914 x 1386 (8.2M pixels) and bends a 1920 x 450 picture.
    const s = ladder(1, false, { w: 3840, h: 900 })[0]
    expect([Math.round(3840 * s.pr), Math.round(900 * s.pr)]).toEqual([5914, 1386])
    expect([3840 * glassScale(s, 1), 900 * glassScale(s, 1)]).toEqual([1920, 450])
  })
})

describe('the governor, timed by the GPU', () => {
  // A GPU whose time is proportional to the pixels drawn: `perPx` ms per drawing-buffer megapixel, plus the glass.
  const W = 1920, H = 900
  const gpuAt = (perPx: number, steps = ladder(1, false)) => (level: number) => {
    const s = steps[level]
    return { dt: 1 / 60, ms: (W * H * s.pr * s.pr / 1e6) * perPx * (s.glass === 2 ? 1.3 : s.glass === 1 ? 1.1 : 1) }
  }
  it('keeps the finest step on a fast GPU', () => {
    const g = new Governor(ladder(1, false))
    expect(run(g, 600, gpuAt(0.3))).toEqual([0])
  })
  it("started at the screen's own pixels (as the hero does), a fast GPU climbs to the finest; a slow one never leaves them for more", () => {
    const steps = ladder(1, false)
    const fast = new Governor(steps, { level: pick(steps, 'native') })
    expect(run(fast, 300, gpuAt(0.3))).toEqual([2, 1, 0])
    // An integrated GPU: 7 ms at its own pixels, 16 ms at 1.5 times them, so it stays put.
    const igpu = new Governor(steps, { level: pick(steps, 'native') })
    expect(run(igpu, 600, gpuAt(3.5))).toEqual([2])
  })
  it('an integrated GPU at 1920x1080 drops the extra pixels and stays at the screen\'s own, with all the glass', () => {
    // About 3.5 ms a megapixel: 7 ms at the screen's own pixels, 28 ms at twice them.
    const g = new Governor(ladder(1, false))
    const seen = run(g, 900, gpuAt(3.5))
    expect(g.step).toEqual({ pr: 1, glass: 2 })
    // Down one step at a time, and it settles (no hunting up and down).
    expect(seen).toEqual([0, 1, 2])
  })
  it('a slower one gives up the glass before any resolution, and never goes under the screen\'s pixels', () => {
    const g = new Governor(ladder(1, false))
    run(g, 2000, gpuAt(9))
    expect(g.step.pr).toBe(1)
    expect(g.step.glass).toBe(0)
  })
  it('steps back up when there is room again (a smaller window), but only as far as fits comfortably', () => {
    const g = new Governor(ladder(1, false))
    run(g, 900, gpuAt(3.5))
    expect(g.level).toBe(2)
    g.reset()
    // The window is now a quarter the size: 1.5 pixels per CSS pixel fit easily (4.4 ms); twice them would be 7.9 ms,
    // under the limit but not comfortably, so it doesn't try.
    const smaller = (level: number) => { const f = gpuAt(3.5)(level); return { ...f, ms: f.ms! / 4 } }
    expect(run(g, 900, smaller)).toEqual([2, 1])
    expect(smaller(1).ms).toBeLessThan(LO_MS)
    // A sixth of the size: all the way up.
    g.reset()
    run(g, 900, (level) => { const f = gpuAt(3.5)(level); return { ...f, ms: f.ms! / 6 } })
    expect(g.level).toBe(0)
  })
  it('a busy page with an idle GPU (long frames, little GPU time) keeps its quality', () => {
    const g = new Governor(ladder(1, false))
    run(g, 900, () => ({ dt: 1 / 20, ms: 2 }))
    expect(g.level).toBe(0)
  })
  it('only counts GPU times measured at the step it is drawing', () => {
    const g = new Governor(ladder(1, false))
    for (let i = 0; i < 200; i++) g.frame(1 / 60, { ms: 40, level: 3 })
    expect(g.level).toBe(0)
  })
  it('its thresholds leave room for the rest of the page in a 60 Hz frame', () => {
    expect(HI_MS).toBeLessThan(1000 / 60)
    expect(LO_MS).toBeLessThan(HI_MS)
  })
})

describe('the governor, with only frame times', () => {
  const steps = ladder(1.5, false)
  it('a screen capped at 30 Hz (or a saver mode) looks slow, but steps down that don\'t help are taken back', () => {
    const g = new Governor(steps)
    const seen = run(g, 1200, () => ({ dt: 1 / 30, ms: null }))
    expect(seen).toEqual([0, 1, 2, 0])
    expect(g.level).toBe(0)
  })
  // Frame time follows the pixels drawn (and the glass), until vsync at 60 Hz.
  const px = (level: number) => steps[level].pr ** 2 * [1, 1.1, 1.25][steps[level].glass]
  const gpuBound = (k: number) => (level: number) => ({ dt: Math.max(1 / 60, k * px(level)), ms: null })
  it('a slow GPU steps down until frames are quick, and stays: at the screen\'s own pixels while a plainer glass does', () => {
    const g = new Governor(steps)
    run(g, 3000, gpuBound(0.0075))
    expect(gpuBound(0.0075)(g.level).dt).toBeLessThanOrEqual(SLOW)
    expect(g.step).toEqual({ pr: 1.5, glass: 1 })
  })
  it('a small saving that hides between screen refreshes doesn\'t stop it, and it goes under the screen\'s pixels only when nothing else will do', () => {
    // 1.5 pixels per CSS pixel is too slow even with plain glass (42 frames a second): 1.13 is the answer.
    const g = new Governor(steps)
    run(g, 4000, gpuBound(0.0105))
    expect(gpuBound(0.0105)(g.level).dt).toBeLessThanOrEqual(SLOW)
    expect(g.step.pr).toBeLessThan(1.5)
    expect(g.step.pr).toBeGreaterThan(1)
  })
  it('one slow moment (a module loading, a hiccup) is not enough to step down', () => {
    const g = new Governor(steps)
    run(g, 45, () => ({ dt: 1 / 20, ms: null }))
    run(g, 45, () => ({ dt: 1 / 60, ms: null }))
    run(g, 45, () => ({ dt: 1 / 20, ms: null }))
    run(g, 200, () => ({ dt: 1 / 60, ms: null }))
    expect(g.level).toBe(0)
  })
  it('never steps up on frame times alone', () => {
    const g = new Governor(steps, { level: 3 })
    run(g, 1000, () => ({ dt: 1 / 120, ms: null }))
    expect(g.level).toBe(3)
  })
})

describe('median', () => {
  it('is the middle value, or the mean of the middle two', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})
