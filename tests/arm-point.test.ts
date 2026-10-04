import { describe, expect, it } from 'vitest'
import { KINDS } from '../src/sim/arm/kind'
import { homeOf, reachDown, type Kin } from '../src/sim/arm/kin'
import { turnBetween } from '../src/sim/arm/layout'
import { headingOf, reachableSpot, spotAt, type Spot } from '../src/sim/arm/point'

/** The height the claw's fingers come down to over a block (main.ts: CLAW_LOW). */
const CLAW_LOW = 0.035
const EACH = Object.values(KINDS)
const held = { c: [0, 0.05, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [0.03, 0.03, 0.03] } as const

/** Marks across the floor in an arm's own terms, out to well past its reach, in every direction. */
function marks(reach: number, step = 0.12): Spot[] {
  const out: Spot[] = []
  const far = reach * 1.5
  for (let x = -far; x <= far; x += step) for (let z = -far; z <= far; z += step) if (Math.hypot(x, z) > 0.02 && Math.hypot(x, z) <= far) out.push({ x, z })
  return out
}

/** The heights main.ts has a spot kept reachable at: the hover B sends the gripper to, halfway, and where the claw closes. */
const heightsOf = (hover: number) => [hover, (hover + CLAW_LOW) / 2, CLAW_LOW]
/** Whether a heading (degrees) is one a base turning through `range` degrees faces. */
const faces = (yaw: number, [min, max]: readonly [number, number]) => [-720, -360, 0, 360, 720].some((turn) => yaw + turn >= min - 1e-3 && yaw + turn <= max + 1e-3)

/** Where B would send the gripper over a mark, and where the claw would take it down to: the tool's spot at each height. */
function wentTo(kin: Kin, mark: Spot, height: number, near = homeOf(kin)): { spot: Spot; exact: boolean } | null {
  const { yaw, reach } = headingOf(mark)
  const r = reachDown(kin, yaw, reach, height, 0, null, near)
  if (!r) return null
  const t = kin.forward(r.pose)
  return { spot: spotAt(t.yaw, t.reach), exact: r.exact }
}
const apart = (a: Spot, b: Spot) => Math.hypot(a.x - b.x, a.z - b.z)

describe('Point: the mark is where the gripper goes, and where it grabs', () => {
  it('goes where the phone points when the arm reaches there, from every pose and holding or not', () => {
    for (const kind of EACH) {
      const kin = kind.kin
      let reachable = 0
      for (const mark of marks(kind.drive.reach[1])) {
        const r = reachableSpot(kin, mark, heightsOf(kind.drive.hover[0]), 0, null, homeOf(kin), kind.drive.reach)
        expect(r, `${kind.id} ${JSON.stringify(mark)}`).not.toBeNull()
        if (r!.exact) { reachable++; expect(apart(r!.spot, mark)).toBeLessThan(1e-3) }
      }
      // A good part of the floor round it is reachable, and a good part isn't.
      expect(reachable, kind.id).toBeGreaterThan(20)
    }
  })

  it('draws the mark where B sends the gripper and A takes the claw down: one spot, at every height it goes through', () => {
    for (const kind of EACH) {
      const kin = kind.kin, near = homeOf(kin)
      const heights = heightsOf(kind.drive.hover[0])
      let worst = 0, pulled = 0
      for (const mark of marks(kind.drive.reach[1])) {
        const r = reachableSpot(kin, mark, heights, 0, null, near, kind.drive.reach)!
        for (const height of heights) {
          const went = wentTo(kin, r.spot, height, near)!
          expect(went.exact, `${kind.id} ${JSON.stringify(mark)} at ${height} m`).toBe(true)
          worst = Math.max(worst, apart(went.spot, r.spot))
        }
        if (!r.exact) pulled++
      }
      // To a millimetre, and past the reach the mark was pulled in rather than left where the gripper can't go.
      expect(worst, kind.id).toBeLessThan(1e-3)
      expect(pulled, kind.id).toBeGreaterThan(0)
    }
  })

  it('brings a mark past the reach in along its own heading, to the edge of what the arm reaches', () => {
    for (const kind of EACH) {
      const kin = kind.kin, near = homeOf(kin)
      const top = kind.drive.reach[1]
      for (const yaw of [-60, -20, 0, 25, 70]) {
        const want = spotAt(yaw, top + 0.8)
        const heights = heightsOf(kind.drive.hover[0])
        const r = reachableSpot(kin, want, heights, 0, null, near, kind.drive.reach)!
        const { yaw: got, reach } = headingOf(r.spot)
        expect(r.exact).toBe(false)
        expect(turnBetween(got, yaw), `${kind.id} ${yaw}`).toBeLessThan(1e-3)
        expect(reach).toBeLessThanOrEqual(top + 1e-6)
        expect(reach).toBeGreaterThan(kind.drive.reach[0])
        // Where the arm's own limit set it (not the drive's), nothing further out on that heading is reachable at every height (the spot sits a millimetre inside the edge).
        if (reach < top - 0.003) for (const out of [reach + 0.003, reach + 0.01, reach + 0.045]) {
          const beyond = spotAt(yaw, out)
          expect(heights.every((h) => wentTo(kin, beyond, h, near)!.exact), `${kind.id} ${yaw} at ${out}`).toBe(false)
        }
      }
    }
  })

  it('brings a mark inside the arm’s least reach out, and one behind it round to where the arm does reach', () => {
    for (const kind of EACH) {
      const kin = kind.kin, near = homeOf(kin)
      const heights = heightsOf(kind.drive.hover[0])
      const inside = reachableSpot(kin, spotAt(0, 0.01), heights, 0, null, near, kind.drive.reach)!
      if (kind.drive.reach[0] > 0.02) expect(inside.exact, kind.id).toBe(false)
      expect(headingOf(inside.spot).reach).toBeGreaterThanOrEqual(kind.drive.reach[0] - 1e-6)
      // Behind: the spot is on a heading the base can turn to, so the arm really goes there.
      const [min, max] = kin.yawRange
      if (max - min < 359) {
        const behind = reachableSpot(kin, spotAt(max + (360 - (max - min)) / 2, 0.4), heights, 0, null, near, kind.drive.reach)!
        // Where the base can't turn to face it (a SCARA's elbow does, from its own swing), it goes to a limit it does.
        expect(behind.exact || faces(headingOf(behind.spot).yaw, kin.yawRange), kind.id).toBe(true)
        for (const h of heights) expect(wentTo(kin, behind.spot, h, near)!.exact, kind.id).toBe(true)
      }
    }
  })

  it('holds still at the edge of the reach while the phone points further out, rather than stepping with it', () => {
    for (const kind of EACH) {
      const kin = kind.kin, near = homeOf(kin), heights = heightsOf(kind.drive.hover[0])
      const top = kind.drive.reach[1]
      for (const yaw of [-45, 0, 30]) {
        const ref = headingOf(reachableSpot(kin, spotAt(yaw, top + 1), heights, 0, null, near, kind.drive.reach)!.spot).reach
        // Past the arm's own limit (a kind whose drive range ends before its arm does has no edge to hold at).
        if (ref >= top - 0.003) continue
        for (let out = ref + 0.004; out <= top + 0.5; out += 0.007) {
          const got = headingOf(reachableSpot(kin, spotAt(yaw, out), heights, 0, null, near, kind.drive.reach)!.spot).reach
          expect(Math.abs(got - ref), `${kind.id} ${yaw} pointing at ${out.toFixed(3)}`).toBeLessThan(1e-3)
        }
      }
    }
  })

  it('keeps to what the gripper can come down on while it holds a block, and with a higher hover', () => {
    for (const kind of EACH) {
      const kin = kind.kin, near = homeOf(kin)
      for (const hover of [kind.drive.hover[1], kind.drive.hover[2]]) {
        for (const mark of marks(kind.drive.reach[1], 0.3)) {
          const heights = heightsOf(hover)
          const r = reachableSpot(kin, mark, heights, 0, held as never, near, kind.drive.reach)
          if (!r) continue
          for (const height of heights) {
            const { yaw, reach } = headingOf(r.spot)
            const down = reachDown(kin, yaw, reach, height, 0, held as never, near)!
            expect(down.exact, `${kind.id} ${hover} ${JSON.stringify(mark)}`).toBe(true)
            expect(apart(spotAt(kin.forward(down.pose).yaw, kin.forward(down.pose).reach), r.spot)).toBeLessThan(1e-3)
          }
        }
      }
    }
  })

  it('costs a few milliseconds at most, however far past the arm the phone points', () => {
    for (const kind of EACH) {
      const kin = kind.kin, near = homeOf(kin)
      const t0 = performance.now()
      const N = 40
      for (let i = 0; i < N; i++) reachableSpot(kin, spotAt(i * 9, 3), heightsOf(kind.drive.hover[0]), 0, null, near, kind.drive.reach)
      expect((performance.now() - t0) / N, kind.id).toBeLessThan(8)
    }
  })
})
