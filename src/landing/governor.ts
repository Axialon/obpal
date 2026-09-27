/**
 * How finely the hero's field draws, kept to what the device can afford. Pure (no three.js), unit-tested in node.
 *
 * The field draws at one of a ladder of steps, finest first. At the top it draws more pixels than the screen has
 * (twice the CSS pixels, as a phone's screen does) for edges with no stairs on them. Steps down give up the cheaper
 * effects first (the extra pixels, then the fine picture of the scene inside the marbles' glass, then that picture),
 * and resolution last: never fewer pixels than the screen has, except on a dense screen (more than one pixel per CSS
 * pixel) that can't keep up even with the plainest glass.
 *
 * It decides from the GPU's own time for each frame, where the browser can measure it (Chrome and Edge): a step down
 * when the field takes more than its share of a 60 Hz frame, a step up when the step above would fit comfortably.
 * Elsewhere it has only the time between frames, which a 30 Hz screen, a saver mode or a busy page lengthen as much
 * as a slow GPU: so it steps down only after two slow windows in a row, and if neither that step nor one more makes
 * frames faster, it goes back to where it was and stays (the frame rate wasn't the field's to fix). It never steps
 * up on frame times alone.
 */

export interface Step {
  /** Drawing-buffer pixels per CSS pixel. */
  pr: number
  /**
   * The marbles' glass: 2 full (the scene behind bent through it, finely), 1 lighter (a coarser picture of the scene,
   * fewer samples of the ribbon inside), 0 plain (no picture of the scene).
   */
  glass: 0 | 1 | 2
}

/**
 * The most pixels the steps above the screen's own may draw (3840 x 2160). What the GPU's time can't see, memory
 * (4 samples of each pixel, and more) and a laptop's battery, stays within what a 4K screen's own pixels would take.
 */
export const BUDGET = 3840 * 2160

/**
 * The ladder for a screen of `dpr` device pixels per CSS pixel, finest first. A phone never draws past 2. Given the
 * canvas's size (CSS px), the steps above the screen's own pixels draw no more than BUDGET pixels (never fewer than
 * the screen's own): a canvas the size of a 1080p screen draws twice its pixels, a 1440p one 1.5 times, a 4K one
 * none extra.
 */
export function ladder(dpr: number, coarse: boolean, css?: { w: number; h: number }): Step[] {
  const native = Math.min(Math.max(dpr || 1, 1), coarse ? 2 : 3)
  const cap = css && css.w * css.h > 0 ? Math.floor(Math.sqrt(BUDGET / (css.w * css.h)) * 100) / 100 : Infinity
  const extra = (pr: number) => Math.max(native, Math.min(pr, cap))
  const steps: Step[] = []
  const add = (pr: number, glass: Step['glass']) => {
    pr = Math.round(pr * 100) / 100
    if (!steps.some((s) => s.pr === pr && s.glass === glass)) steps.push({ pr, glass })
  }
  if (!coarse) { add(extra(Math.max(native, 2)), 2); add(extra(Math.max(native, 1.5)), 2) }
  add(native, 2)
  add(native, 1)
  add(native, 0)
  add(Math.max(1, native * 0.75), 0)
  add(1, 0)
  return steps
}

/**
 * The picture of the scene behind the marbles' glass, in its pixels per CSS pixel at a step: half the pixels the step
 * draws, at most half the screen's own (the glass shows it shrunk three times or more), less for lighter glass, none
 * for plain. It follows the drawing buffer down, and never above it (nor its budget).
 */
export function glassScale(step: Step, dpr: number): number {
  const part = step.glass === 2 ? 0.5 : step.glass === 1 ? 0.3 : 0
  return part * Math.min(step.pr, dpr || 1, 2)
}

/**
 * A step by name (or number), to hold the field at: super (the finest), native (the screen's own pixels, all the
 * glass), lite (lighter glass), plain (no picture in the glass), low (the plainest). -1 if there's no such step.
 */
export function pick(steps: readonly Step[], name: string): number {
  if (/^\d+$/.test(name)) return Math.min(steps.length - 1, Number(name))
  const native = steps.find((s) => s.glass === 1)?.pr ?? steps[0].pr
  const at = {
    super: 0,
    native: steps.findIndex((s) => s.pr === native && s.glass === 2),
    lite: steps.findIndex((s) => s.glass === 1),
    plain: steps.findIndex((s) => s.glass === 0),
    low: steps.length - 1,
  }[name]
  return at ?? -1
}

/** The field's share of a 60 Hz frame (ms of GPU time): above HI it steps down; it steps up if the step above fits LO. */
export const HI_MS = 10
export const LO_MS = 6.5
/** Frame times (s) above this are too slow (under 50 frames a second). */
export const SLOW = 1 / 50
/** A step down that doesn't make frames at least this much faster didn't help. */
const HELPED = 0.88

export interface GpuSample {
  ms: number
  /** The step the frame was drawn at. */
  level: number
}

export class Governor {
  level: number
  private readonly steps: Step[]
  /** Frames per decision. */
  private readonly size: number
  private dts: number[] = []
  private gpu: number[] = []
  /** The GPU time last measured at each step (ms), at this screen size. */
  private known: (number | undefined)[] = []
  /** Steps down on frame times alone, to confirm: the level they came from, its median frame time, how many steps. */
  private trial: { from: number; median: number; tries: number } | null = null
  private slowWindows = 0
  /** Frame times alone won't step below this (a step down here didn't help). */
  private floor: number

  constructor(steps: Step[], opts: { level?: number; window?: number } = {}) {
    this.steps = steps
    this.level = Math.max(0, Math.min(steps.length - 1, opts.level ?? 0))
    this.floor = steps.length - 1
    this.size = opts.window ?? 45
  }

  /** The step to draw at. */
  get step(): Step { return this.steps[this.level] }

  /**
   * One drawn frame: the time since the one before (s), and the GPU's time for an earlier frame when a measurement
   * has come back. Returns the level to draw at from now on (it changes only at the end of a window).
   */
  frame(dt: number, gpu: GpuSample | null = null): number {
    this.dts.push(dt)
    if (gpu && gpu.level === this.level && Number.isFinite(gpu.ms)) this.gpu.push(gpu.ms)
    if (this.dts.length < this.size) return this.level
    const dts = this.dts, gpus = this.gpu
    this.dts = []
    this.gpu = []
    if (gpus.length >= dts.length * 0.5) this.byGpu(median(gpus))
    else this.byFrames(median(dts))
    return this.level
  }

  /** The screen changed size: what was learned about each step no longer holds. */
  reset() {
    this.known = []
    this.trial = null
    this.slowWindows = 0
    this.floor = this.steps.length - 1
    this.dts = []
    this.gpu = []
  }

  private byGpu(ms: number) {
    this.trial = null
    this.slowWindows = 0
    this.known[this.level] = ms
    if (ms > HI_MS) {
      if (this.level < this.steps.length - 1) this.go(this.level + 1)
      return
    }
    if (this.level === 0) return
    const up = this.level - 1
    const guess = this.known[up] ?? ms * cost(this.steps[up], this.steps[this.level])
    if (guess < LO_MS) this.go(up)
  }

  private byFrames(dt: number) {
    const t = this.trial
    if (t) {
      if (dt <= t.median * HELPED) { this.trial = null; this.slowWindows = 0; return }
      // A small saving can hide between two refreshes of the screen: one more step tells.
      if (t.tries < 2 && this.level < this.steps.length - 1) { t.tries++; this.go(this.level + 1); return }
      // No faster: whatever holds the frame rate back, it isn't the drawing. Back to where it was, and stay there.
      this.trial = null
      this.floor = t.from
      this.go(t.from)
      return
    }
    if (dt <= SLOW) { this.slowWindows = 0; return }
    if (++this.slowWindows < 2 || this.level >= this.floor) return
    this.slowWindows = 0
    this.trial = { from: this.level, median: dt, tries: 1 }
    this.go(this.level + 1)
  }

  private go(level: number) {
    this.level = level
    this.dts = []
    this.gpu = []
  }
}

/** Roughly how much more a step costs than another: its pixels, and the glass's picture of the scene. */
function cost(a: Step, b: Step): number {
  return ((a.pr / b.pr) ** 2) * (a.glass > b.glass ? 1.35 : 1)
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((p, q) => p - q)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
