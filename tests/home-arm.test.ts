import { describe, expect, it } from 'vitest'
import {
  aim, BLOCK, CLEAR, FINGER, follow, HOLD, JOINT_R, LOW, lowest, PADS, PLATE, pose, SHOULDER, story, STORY_S, TABLE,
  type Arm, type Pose,
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

  it('keeps facing its way right over the base, rather than turning to and fro', () => {
    const facingRight = aim({ x: SHOULDER.x - 3, y: 120 }, 0.2)
    const facingLeft = aim({ x: SHOULDER.x + 3, y: 120 }, Math.PI - 0.2)
    expect(facingRight.turn).toBe(0)
    expect(facingLeft.turn).toBe(Math.PI)
  })
})
