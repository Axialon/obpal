import { describe, expect, it } from 'vitest'
import {
  aim, BLOCK, CLEAR, FINGER, follow, HOLD, JOINT_R, LOW, lowest, PADS, play as playPlan, PLATE, pose, SHOULDER, spotAt, story, storyFrom, STORY_S, TABLE,
  tidy, type Arm, type Leg, type Pose,
} from '../src/landing/arm'

/** How far above the table the drawn arm's lowest part is (links, joints and their rims, fingertips). */
const above = (p: Pose) => TABLE - lowest(p)

/** Elbow up: above the shoulder, and (where the arm isn't edge on) above the line from the shoulder to the hand. */
function elbowUp(p: Pose): boolean {
  const { shoulder: s, elbow: e, wrist: w, facing } = p
  if (e.y >= s.y) return false
  if (Math.abs(facing) < 0.2) return true
  // In the arm's own plane (unmirrored): reach out, height up.
  const er = (e.x - s.x) / facing, eh = s.y - e.y, wr = (w.x - s.x) / facing, wh = s.y - w.y
  return wr * eh - wh * er > -1e-9
}

/** Play the arm as the scene does, `seconds` long in steps of `dt`, headed wherever `to(t)` says; check each frame. */
function play(start: Arm, to: (t: number, a: Arm) => Arm, seconds: number, dt: number) {
  let a = start, least = Infinity, jump = 0
  let last = pose(a)
  for (let t = 0; t < seconds; t += dt) {
    a = follow(a, to(t, a), dt)
    const p = pose(a)
    least = Math.min(least, above(p))
    expect(elbowUp(p), `elbow up at t=${t.toFixed(2)}`).toBe(true)
    jump = Math.max(jump, Math.hypot(p.elbow.x - last.elbow.x, p.elbow.y - last.elbow.y) / dt)
    last = p
  }
  return { least, jump, end: a }
}

describe('the home page robot arm never goes below the table', () => {
  it('stands on the table: the turntable on it, the shoulder on the turntable', () => {
    expect(PLATE.y + PLATE.h).toBe(TABLE)
    expect(SHOULDER.y).toBeLessThan(PLATE.y + PLATE.h)
    expect(SHOULDER.y + JOINT_R[0]).toBeGreaterThan(PLATE.y)
    expect(SHOULDER.x).toBeGreaterThan(PLATE.x)
    expect(SHOULDER.x).toBeLessThan(PLATE.x + PLATE.w)
  })

  it('grips a block resting on the table at its lowest, fingertips clear', () => {
    expect(LOW + HOLD + BLOCK / 2).toBe(TABLE)
    expect(LOW + FINGER.to + FINGER.w / 2).toBe(TABLE - CLEAR)
  })

  it('keeps every part above the table all through its pick and place, elbow up', () => {
    // The story's own targets, sampled over the whole round.
    for (let t = 0; t <= STORY_S; t += 1 / 240) {
      const p = pose(story(t).arm)
      expect(above(p), `t=${t.toFixed(3)}`).toBeGreaterThanOrEqual(CLEAR - 1e-9)
      expect(elbowUp(p), `elbow up at t=${t.toFixed(3)}`).toBe(true)
    }
    // And as drawn, following it (three rounds, at a fast screen's frames, a usual one's, and the longest the page gives).
    for (const dt of [1 / 120, 1 / 60, 0.05]) {
      const { least } = play(story(0).arm, (t) => story(t).arm, STORY_S * 3, dt)
      expect(least).toBeGreaterThanOrEqual(CLEAR - 1e-9)
    }
  })

  it('reaches each pad, facing its side, and puts the block down on the table there', () => {
    for (const [i, pad] of PADS.entries()) {
      // The grip closes halfway through its leg: over the pad, at the lowest.
      const t = STORY_S / 2 * i + 1.1 + 0.6 + 0.15
      const s = story(t)
      const p = pose(s.arm)
      expect(p.wrist.x).toBeCloseTo(pad.x, 6)
      expect(p.wrist.y).toBeCloseTo(LOW, 6)
      expect(Math.sign(p.facing)).toBe(Math.sign(pad.x - SHOULDER.x))
      expect(s.grip).toBeGreaterThan(0.3)
    }
  })

  it('follows a pointer anywhere, under the table too, without going below it', () => {
    const starts = [story(0).arm, story(STORY_S / 2).arm, { r: 0, y: 40, turn: Math.PI / 2 }]
    for (const start of starts) {
      for (let x = -60; x <= 460; x += 20) {
        for (let y = -60; y <= 320; y += 20) {
          const { least } = play(start, (_, a) => aim({ x, y }, a.turn), 1.5, 1 / 60)
          expect(least, `pointer at ${x}, ${y}`).toBeGreaterThanOrEqual(CLEAR - 1e-9)
        }
      }
    }
  })

  it('turns its base to reach the other side, low along the table, its elbow up and moving smoothly', () => {
    // The pointer swept along the table, right to left and back, a little faster than a hand.
    const sweep = (t: number, a: Arm) => aim({ x: 204 + 190 * Math.cos(t * 2.4), y: 230 }, a.turn)
    const { least, jump } = play({ r: 150, y: LOW, turn: 0 }, sweep, 8, 1 / 60)
    expect(least).toBeGreaterThanOrEqual(CLEAR - 1e-9)
    // No sudden flip of the elbow from one side to the other: it moves under 1500 units a second (the card is 400 wide).
    expect(jump).toBeLessThan(1500)
    // And it gets there: right, then left.
    const right = play({ r: 0, y: 150, turn: Math.PI }, (_, a) => aim({ x: 380, y: 210 }, a.turn), 2, 1 / 60).end
    const left = play({ r: 0, y: 150, turn: 0 }, (_, a) => aim({ x: 20, y: 210 }, a.turn), 2, 1 / 60).end
    expect(pose(right).wrist.x).toBeGreaterThan(360)
    expect(pose(left).wrist.x).toBeLessThan(45)
    expect(pose(right).wrist.y).toBeCloseTo(LOW, 1)
  })

  it('turns its base through its front half only (0 to π), never round its back, as the sim\'s arms keep theirs out of the work', () => {
    const within = (a: Arm) => { expect(a.turn).toBeGreaterThanOrEqual(0); expect(a.turn).toBeLessThanOrEqual(Math.PI) }
    let a = story(0).arm
    for (let t = 0; t < STORY_S * 2; t += 1 / 60) { a = follow(a, story(t).arm, 1 / 60); within(a) }
    for (const start of [story(0).arm, story(STORY_S / 2).arm]) {
      for (let x = -60; x <= 460; x += 40) {
        let b = start
        for (let i = 0; i < 90; i++) { b = follow(b, aim({ x, y: 150 }, b.turn), 1 / 60); within(b) }
      }
    }
  })

  it('keeps facing its way right over the base, rather than turning to and fro', () => {
    const facingRight = aim({ x: SHOULDER.x - 3, y: 120 }, 0.2)
    const facingLeft = aim({ x: SHOULDER.x + 3, y: 120 }, Math.PI - 0.2)
    expect(facingRight.turn).toBe(0)
    expect(facingLeft.turn).toBe(Math.PI)
  })
})

describe('after someone plays with the home page arm, it tidies up and plays on', () => {
  /** Play a plan from the arm as it is, as the scene does (60 frames a second): the lowest it went, and where it ended. */
  function run(from: Arm, legs: Leg[]) {
    const start: Leg = [from.turn, from.r, from.y, 0, 0]
    let a = from, least = Infinity
    // Through the plan, and a second more for the arm to catch up with its end.
    for (let t = 0, after = 0; after < 1 && t < 60; t += 1 / 60) {
      const r = playPlan(legs, start, t)
      if (r.done) after += 1 / 60
      a = follow(a, r.arm, 1 / 60)
      least = Math.min(least, TABLE - lowest(pose(a)))
    }
    return { least, end: a }
  }

  it('puts the block on the pad nearest it: carried there if held, picked up from where it lies first if not, left be on a pad', () => {
    for (const x of [60, 120, 150, 250, 300, 350]) {
      for (const held of [true, false]) {
        const { legs, pad } = tidy({ x, held })
        expect(pad).toBe(Math.abs(x - PADS[0].x) <= Math.abs(x - PADS[1].x) ? 0 : 1)
        // It ends over that pad, open, the block let go on it.
        const last = legs.at(-1)!, drop = legs.at(-2)!
        expect([last[0], last[1], last[3]]).toEqual([PADS[pad].turn, PADS[pad].r, 0])
        expect([drop[1], drop[2]]).toEqual([PADS[pad].r, LOW])
        // Not held, it first goes down and grips where the block lies.
        if (!held) expect(legs.slice(0, 3).map((l) => [l[1], l[3]])).toEqual([[spotAt(x).r, 0], [spotAt(x).r, 0], [spotAt(x).r, 1]])
        else expect(legs[0][3]).toBe(1)
      }
    }
    for (const [i, pd] of PADS.entries()) expect(tidy({ x: pd.x, held: false })).toEqual({ legs: [], pad: i })
  })

  it('tidies without going below the table, and the story takes over where the tidying ends, with no jump', () => {
    for (const from of [{ r: 120, y: LOW, turn: 0 }, { r: 60, y: 90, turn: Math.PI }, { r: 150, y: 170, turn: 0 }] as Arm[]) {
      for (const block of [{ x: 250, held: false }, { x: 130, held: true }, { x: 350, held: true }]) {
        const { legs, pad } = tidy(block)
        const { least, end } = run(from, legs)
        expect(least, `${JSON.stringify({ from, block })}`).toBeGreaterThanOrEqual(CLEAR - 1e-9)
        const next = story(storyFrom(pad)).arm
        expect(Math.hypot(pose(end).wrist.x - pose(next).wrist.x, pose(end).wrist.y - pose(next).wrist.y)).toBeLessThan(1)
      }
    }
  })

  it('plays a plan from where the arm was, and says when it has', () => {
    const legs: Leg[] = [[0, 100, 150, 1, 1], [0, 120, LOW, 0, 0.5]]
    const from: Leg = [Math.PI, 80, 100, 0, 0]
    expect(playPlan(legs, from, 0)).toEqual({ arm: { turn: Math.PI, r: 80, y: 100 }, grip: 0, done: false })
    expect(playPlan(legs, from, 1).arm).toEqual({ turn: 0, r: 100, y: 150 })
    expect(playPlan(legs, from, 2)).toEqual({ arm: { turn: 0, r: 120, y: LOW }, grip: 0, done: true })
    expect(storyFrom(0)).toBe(0)
    expect(storyFrom(1)).toBe(STORY_S / 2)
  })
})
