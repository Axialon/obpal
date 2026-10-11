import { describe, expect, it } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import { ActorControl, restIntent } from '../src/sim/humanoid/controls'
import { forward } from '../src/sim/humanoid/ik'
import { neutral, SOFT_PROFILES } from '../src/sim/humanoid/profile'

const profile = SOFT_PROFILES.cairn[0]
const up = new Vector3(0, 1, 0)
/** Material points and orientation in world space, including the actor's heading. */
function soles(actor: ActorControl) {
  const posed = actor.visualGait!.pose(actor.q, actor.position, actor.facing, .0001), fk = forward(profile, posed.q)
  return Object.fromEntries(profile.chains.filter(c => c.group === 'legs').map(chain => {
    const skin = profile.skins.find(s => s.joint === chain.end && s.finish === 'trim')!, foot = fk.get(chain.end)!
    const points = [-1, 1].flatMap(x => [-1, 1].map(z => new Vector3(skin.offset[0] + x * skin.size[0] / 2, skin.offset[1] - skin.size[1] / 2, skin.offset[2] + z * skin.size[2] / 2)
      .applyQuaternion(foot.q).add(foot.p).add(posed.offset).applyAxisAngle(up, actor.facing).add(actor.position)))
    return [chain.side < 0 ? 'left' : 'right', { points, rotation: new Quaternion().setFromAxisAngle(up, actor.facing).multiply(foot.q) }]
  }))
}
const displacement = (a: ReturnType<typeof soles>, b: ReturnType<typeof soles>) => Math.max(...Object.keys(a).flatMap(side => a[side].points.map((p, i) => p.distanceTo(b[side].points[i]))))
describe('Cairn I classical practice feet', () => {
  it.each([[0, -1], [0, 1], [-1, 0], [1, 0], [1, -1], [-1, 1]])('plants feet while root motion continues in %s/%s', (x, z) => {
    const actor = new ActorControl(profile), anchors = new Map<string, Vector3>()
    let maxSlip = 0, swing = 0, minGap = Infinity
    for (let i = 0; i < 150; i++) {
      const q = actor.step(1 / 60, { x, z, yaw: 0, manual: true }, null)
      const gait = actor.visualGait!, posed = gait.pose(q, actor.position, actor.facing, -.002), fk = forward(profile, posed.q)
      for (const chain of profile.chains.filter(c => c.group === 'legs')) {
        const side = chain.side < 0 ? 'left' : 'right', f = fk.get(chain.end)!, skin = profile.skins.find(s => s.joint === chain.end && s.finish === 'trim')!
        const sole = new Vector3(...skin.offset).add(new Vector3(0, -skin.size[1] / 2, 0)).applyQuaternion(f.q).add(f.p).add(posed.offset).applyAxisAngle(up, actor.facing).add(actor.position)
        minGap = Math.min(minGap, sole.y + .002)
        if (gait.feet[side].stance) {
          if (anchors.has(side)) maxSlip = Math.max(maxSlip, sole.distanceTo(anchors.get(side)!))
          else anchors.set(side, sole.clone())
        } else { anchors.delete(side); swing = Math.max(swing, sole.y + .002) }
      }
      for (const joint of profile.joints) {
        expect(posed.q[joint.id]).toBeGreaterThanOrEqual(joint.limits[0])
        expect(posed.q[joint.id]).toBeLessThanOrEqual(joint.limits[1])
      }
    }
    expect(actor.position.length()).toBeGreaterThan(2)
    expect(minGap).toBeGreaterThanOrEqual(-.001)
    expect(maxSlip).toBeLessThanOrEqual(.01)
    expect(swing).toBeGreaterThanOrEqual(.01)
  })
  it('does not move the support anchor by a first root frame after claiming the local source', () => {
    const actor = new ActorControl(profile)
    actor.step(1 / 60, restIntent(), null)
    const ankle = forward(profile, actor.q).get('left.leg.ankle.roll')!.p.clone()
    actor.resetSource()
    actor.visualGait!.seed('left', ankle, 0)
    actor.step(1 / 60, { x: 0, z: -1, yaw: 0, manual: true }, null)
    const at = forward(profile, actor.q).get('left.leg.ankle.roll')!.p.add(actor.position)
    expect(Math.hypot(at.x - ankle.x, at.z - ankle.z)).toBeLessThan(.001)
    expect(actor.position.z).toBeLessThan(-.01)
  })
  it('clears anchors on Stop, source reset and BODY interruption without moving the root', () => {
    const actor = new ActorControl(profile)
    for (let i = 0; i < 20; i++) actor.step(1 / 60, { x: 0, z: -1, yaw: 0, manual: true }, null)
    actor.stop(); const position = actor.position.clone(), q = { ...actor.q }
    actor.step(.05, { x: 1, z: 1, yaw: 1, manual: true }, null)
    expect(actor.position).toEqual(position); expect(actor.q).toEqual(q); expect(actor.visualGait!.active).toBe(false)
    actor.resume(); actor.step(.02, restIntent(), null); actor.resetSource()
    expect(Object.keys(actor.visualGait!.feet)).toHaveLength(0)
    const body = neutral(profile); body['left.arm.elbow'] = .8
    const legs = profile.chains.filter(c => c.group === 'legs').flatMap(c => [...c.joints, ...c.distal])
    expect(legs).toHaveLength(12)
    for (const id of legs) {
      const joint = profile.joints.find(j => j.id === id)!, rest = body[id]
      const endpoint = Math.abs(joint.limits[0] - rest) > Math.abs(joint.limits[1] - rest) ? joint.limits[0] : joint.limits[1]
      body[id] = (rest + endpoint) / 2
      expect(body[id]).not.toBe(rest)
      expect(body[id]).toBeGreaterThanOrEqual(joint.limits[0])
      expect(body[id]).toBeLessThanOrEqual(joint.limits[1])
    }
    actor.step(.02, restIntent(), body)
    expect(actor.visualGait!.active).toBe(false); expect(actor.q['left.arm.elbow']).toBe(.8)
    for (const id of legs) expect(Math.abs(actor.q[id] - body[id])).toBeLessThanOrEqual(1e-6)
    expect(actor.position).toEqual(position)
    actor.step(.02, restIntent(), null)
    expect(actor.visualGait!.active).toBe(true); expect(actor.position).toEqual(position)
  })
  it('leaves every other soft form on the previous gait path', () => {
    for (const p of Object.values(SOFT_PROFILES).flat().filter(p => p.model !== 'cairn-i')) expect(new ActorControl(p).visualGait).toBeNull()
  })
  it.each(['left', 'right'])('finishes a %s middle swing continuously when input is released, reversed or resumed', side => {
    for (const change of [restIntent(), { x: -1, z: 1, yaw: -1, manual: true }, { x: 1, z: -1, yaw: 1, manual: true }]) {
      const changes = [.001, .0001, .00001].map(dt => {
        const actor = new ActorControl(profile), moving = { x: 1, z: -1, yaw: .2, manual: true }
        for (let i = 0; i < 600; i++) {
          actor.step(.001, moving, null)
          const foot = actor.visualGait!.feet[side]
          if (!foot.stance && foot.phase > .73 && foot.phase < .8) break
        }
        expect(actor.visualGait!.feet[side].stance).toBe(false)
        expect(actor.visualGait!.feet[side].phase).toBeGreaterThan(.73)
        expect(actor.visualGait!.feet[side].phase).toBeLessThan(.8)
        const before = soles(actor)
        actor.step(dt, change, null)
        const after = soles(actor)
        for (const name of ['left', 'right']) expect(before[name].rotation.angleTo(after[name].rotation)).toBeLessThan(.02)
        if (!change.manual) {
          const cycle = actor.visualGait!.feet[side].cycle
          for (let i = 0; i < 600 && !actor.visualGait!.feet[side].stance; i++) actor.step(.001, change, null)
          expect(actor.visualGait!.feet[side].stance).toBe(true)
          expect(actor.visualGait!.feet[side].cycle).toBe(cycle + 1)
          const anchor = soles(actor)[side].points.map(p => p.clone())
          actor.step(.001, { x: 0, z: 1, yaw: 0, manual: true }, null)
          expect(Math.max(...soles(actor)[side].points.map((p, n) => p.distanceTo(anchor[n])))).toBeLessThan(.01)
        }
        return displacement(before, after)
      })
      expect(changes[2]).toBeLessThan(.0005)
      expect(changes[2]).toBeLessThan(changes[0] * .05 + 1e-8)
    }
  })
  it('pure yaw preserves both soles through lift-off and touchdown', () => {
    const actor = new ActorControl(profile)
    actor.step(.001, restIntent(), null)
    let previous = soles(actor), max = 0
    for (let i = 0; i < 1600; i++) {
      actor.step(.001, { x: 0, z: 0, yaw: 1, manual: true }, null)
      const next = soles(actor)
      max = Math.max(max, displacement(previous, next)); previous = next
      for (const joint of profile.joints) expect(actor.q[joint.id]).toBeGreaterThanOrEqual(joint.limits[0])
    }
    expect(max).toBeLessThan(.005)
  })
  it.each([1, -1])('keeps touchdown continuous while walking and turning in direction %s', yaw => {
    const actor = new ActorControl(profile)
    actor.yaw = -Math.PI / 2
    actor.step(.005, restIntent(), null)
    let previous = soles(actor), max = 0, maxTransition = 0, worst = {}, maxSlip = 0, minMiddle = Infinity
    const anchors = new Map<string, Vector3[]>()
    for (let i = 0; i < 700; i++) {
      const beforePhase = Object.fromEntries(Object.entries(actor.visualGait!.feet).map(([side, f]) => [side, { phase: f.phase, stance: f.stance }]))
      actor.step(.005, { x: 0, z: 1, yaw, manual: true }, null)
      const next = soles(actor)
      const delta = displacement(previous, next)
      if (Object.entries(actor.visualGait!.feet).some(([side, f]) => f.stance !== beforePhase[side].stance)) maxTransition = Math.max(maxTransition, delta)
      for (const [side, sole] of Object.entries(next)) {
        const foot = actor.visualGait!.feet[side]
        if (foot.stance) {
          if (anchors.has(side)) maxSlip = Math.max(maxSlip, ...sole.points.map((p, n) => p.distanceTo(anchors.get(side)![n])))
          else anchors.set(side, sole.points.map(p => p.clone()))
        } else { anchors.delete(side); if (foot.phase >= .675 && foot.phase <= .825) minMiddle = Math.min(minMiddle, ...sole.points.map(p => p.y - .0001)) }
      }
      if (delta > max) worst = { i, delta, beforePhase, afterPhase: Object.fromEntries(Object.entries(actor.visualGait!.feet).map(([side, f]) => [side, { phase: f.phase, stance: f.stance }])) }
      max = Math.max(max, delta); previous = next
    }
    expect(maxTransition, JSON.stringify({ worst, max, maxSlip, minMiddle })).toBeLessThanOrEqual(4 * .005 + .001)
    expect(maxSlip).toBeLessThanOrEqual(.01)
    expect(minMiddle).toBeGreaterThanOrEqual(.01)
  })
  it.each(['fixed deadline', 'observed .75'])('keeps the completed forward landing planted when backward motion resumes after %s', release => {
    const actor = new ActorControl(profile), anchors = new Map<string, Vector3[]>()
    actor.yaw = -Math.PI / 2
    let maxSlip = 0
    let interrupted: { side: string; cycle: number } | null = null
    for (const [seconds, input] of [[.6, restIntent()], [2.6, { x: 0, z: -1, yaw: 0, manual: true }], [.7, restIntent()], [2.6, { x: 0, z: 1, yaw: 0, manual: true }]] as const) {
      for (let elapsed = 0; elapsed < seconds - 1e-8; elapsed += 1 / 60) {
        actor.step(Math.min(1 / 60, seconds - elapsed), input, null)
        if (release === 'observed .75' && input.z === -1 && elapsed > .5) {
          const f = actor.visualGait!.feet.left
          if (!f.stance && f.phase >= .75 && f.phase < .8) { interrupted = { side: 'left', cycle: f.cycle }; break }
        }
        for (const [side, sole] of Object.entries(soles(actor))) {
          if (actor.visualGait!.feet[side].stance) {
            if (anchors.has(side)) maxSlip = Math.max(maxSlip, ...sole.points.map((p, n) => p.distanceTo(anchors.get(side)![n])))
            else anchors.set(side, sole.points.map(p => p.clone()))
          } else anchors.delete(side)
        }
      }
      if (release === 'observed .75' && input.z === -1) expect(interrupted).not.toBeNull()
      if (release === 'observed .75' && input.z === 0 && interrupted) {
        const f = actor.visualGait!.feet[interrupted.side]
        expect(f.stance).toBe(true)
        expect(f.cycle).toBe(interrupted.cycle + 1)
        expect(f.phase).toBeLessThan(.05)
      }
    }
    expect(maxSlip).toBeLessThanOrEqual(.01)
  })
  it.each([['reverse', .75], ['late pure turn', .75], ['late pure turn', .9]] as const)('bounds every airborne rebase through landing after %s at %s', (change, phase) => {
    const actor = new ActorControl(profile); actor.yaw = -Math.PI / 2
    actor.step(1 / 60, restIntent(), null)
    let previous = soles(actor), changed = false, max = 0, worst = {}, landed = false
    const protectedFeet = new Set<string>()
    for (let i = 0; i < 240; i++) {
      const f = actor.visualGait!.feet.right
      const interruptedNow = !changed && !f.stance && f.phase >= phase && f.phase < phase + .05
      if (interruptedNow) changed = true
      const input = !changed ? { x: 0, z: -1, yaw: 1, manual: true }
        : { x: 0, z: change === 'reverse' ? 1 : 0, yaw: -1, manual: true }
      const before = Object.fromEntries(Object.entries(actor.visualGait!.feet).map(([side, f]) => [side, { stance: f.stance, fromPhase: f.fromPhase, to: f.to.toArray(), yaw: f.toYaw }]))
      actor.step(1 / 60, input, null)
      const next = soles(actor)
      for (const [side, f] of Object.entries(actor.visualGait!.feet)) {
        const b = before[side], edge = b.fromPhase !== f.fromPhase || b.yaw !== f.toYaw || JSON.stringify(b.to) !== JSON.stringify(f.to.toArray())
        if (!b.stance && (edge || interruptedNow)) protectedFeet.add(side)
        if (protectedFeet.has(side) || changed && change === 'late pure turn') {
          const delta = Math.max(...next[side].points.map((p, n) => p.distanceTo(previous[side].points[n])))
          if (delta > max) worst = { i, side, delta, phase: f.phase, fromPhase: f.fromPhase, landing: f.to.toArray() }
          max = Math.max(max, delta)
          expect(previous[side].rotation.angleTo(next[side].rotation)).toBeLessThanOrEqual(8 / 60 + Math.PI / 180)
        }
        if (protectedFeet.has(side) && f.stance) { protectedFeet.delete(side); landed = true }
      }
      previous = next
    }
    expect(changed && landed).toBe(true)
    expect(max, JSON.stringify(worst)).toBeLessThanOrEqual(4 / 60 + .001)
    console.info('Cairn protected CPU path', JSON.stringify({ change, phase, maxMaterialDeltaM: max, worst }))
  })
  it.each([[1, 66], [-1, 289]])('ordinary middle-swing material motion tends to zero with elapsed time (%s/%s)', (yaw, frame) => {
    const runs = [.001, .0001, .00001].map(dt => {
      const actor = new ActorControl(profile); actor.yaw = -Math.PI / 2
      actor.step(.005, restIntent(), null)
      for (let i = 0; i < frame; i++) actor.step(.005, { x: 0, z: 1, yaw, manual: true }, null)
      const before = soles(actor)
      let previous = before, max = 0, maxAngle = 0
      for (let elapsed = 0; elapsed < .005 - 1e-10; elapsed += dt) {
        actor.step(dt, { x: 0, z: 1, yaw, manual: true }, null)
        const next = soles(actor)
        max = Math.max(max, displacement(previous, next))
        maxAngle = Math.max(maxAngle, ...Object.keys(next).map(side => previous[side].rotation.angleTo(next[side].rotation)))
        previous = next
      }
      return { max, maxAngle, final: previous, plan: Object.fromEntries(Object.entries(actor.visualGait!.feet).map(([side, f]) => [side, { phase: f.phase, landing: f.to.toArray(), yaw: f.toYaw, segment: f.fromPhase }])) }
    })
    const deltas = runs.map(r => r.max)
    expect(deltas[2]).toBeLessThan(.0005)
    expect(deltas[2]).toBeLessThan(deltas[0] * .05 + 1e-8)
    expect(runs[2].maxAngle).toBeLessThan(runs[0].maxAngle * .05 + 1e-8)
    expect(displacement(runs[1].final, runs[2].final)).toBeLessThan(displacement(runs[0].final, runs[2].final) + 1e-8)
    expect(displacement(runs[0].final, runs[2].final), JSON.stringify(runs.map(r => r.plan))).toBeLessThan(.001)
    for (const side of ['left', 'right']) expect(runs[0].final[side].rotation.angleTo(runs[2].final[side].rotation)).toBeLessThan(.001)
    console.info('Cairn matched 5ms subdivisions', JSON.stringify({ yaw, frame, runs: runs.map(r => ({ max: r.max, maxAngle: r.maxAngle, plan: r.plan, final: Object.fromEntries(Object.entries(r.final).map(([side, sole]) => [side, { points: sole.points.map(p => p.toArray()), rotation: sole.rotation.toArray() }])) })), finalDeltaM: displacement(runs[0].final, runs[2].final) }))
  })
  it('finishes a forward swing when translation changes to pure turning in the matched pilot', () => {
    const actor = new ActorControl(profile); actor.yaw = -Math.PI / 2
    let previous = soles(actor), maximum = 0, worst = {}
    const sequence = [restIntent(), { x: 0, z: 1, yaw: 0, manual: true }, restIntent(), { x: 0, z: 0, yaw: -1, manual: true }, { x: 0, z: -1, yaw: 0, manual: true }, { x: 0, z: 0, yaw: 1, manual: true }]
    for (const [phase, input] of sequence.entries()) for (let frame = 0; frame < 60; frame++) {
      actor.step(1 / 60, input, null)
      const next = soles(actor), delta = displacement(previous, next)
      if (phase === 5 && delta > maximum) { maximum = delta; worst = { frame, delta, feet: Object.fromEntries(Object.entries(actor.visualGait!.feet).map(([side, f]) => [side, { phase: f.phase, segment: f.fromPhase, from: f.from.toArray(), to: f.to.toArray() }])) } }
      previous = next
    }
    expect(maximum, JSON.stringify(worst)).toBeLessThanOrEqual(4 / 60 + .001)
  })
  it('keeps support planted when reverse heading arrives one frame after reverse translation', () => {
    const actor = new ActorControl(profile); actor.yaw = -Math.PI / 2
    const anchors = new Map<string, Vector3[]>()
    let maxSlip = 0, worst = {}, minGap = Infinity
    const step = (input: ReturnType<typeof restIntent>) => {
      actor.step(1 / 60, input, null)
      const posed = actor.visualGait!.pose(actor.q, actor.position, actor.facing, .0001)
      for (const j of profile.joints) expect(posed.q[j.id]).toBeGreaterThanOrEqual(j.limits[0])
      for (const j of profile.joints) expect(posed.q[j.id]).toBeLessThanOrEqual(j.limits[1])
      for (const [side, sole] of Object.entries(soles(actor))) {
        const f = actor.visualGait!.feet[side]
        minGap = Math.min(minGap, ...sole.points.map(p => p.y - .0001))
        if (!f.stance) anchors.delete(side)
        else if (!anchors.has(side)) anchors.set(side, sole.points.map(p => p.clone()))
        else {
          const slip = Math.max(...sole.points.map((p, n) => p.distanceTo(anchors.get(side)![n])))
          if (slip > maxSlip) worst = { side, slip, phase: f.phase, rootYaw: actor.facing, plannedYaw: f.toYaw, legYaw: posed.q[`${side}.leg.yaw`] }
          maxSlip = Math.max(maxSlip, slip)
        }
      }
    }
    const middle = (side: string, input: ReturnType<typeof restIntent>) => {
      for (let i = 0; i < 120; i++) {
        step(input)
        const f = actor.visualGait!.feet[side]
        if (!f.stance && f.phase >= .7 && f.phase <= .8) return
      }
      throw Error('Observed middle swing unavailable')
    }
    step(restIntent())
    middle('left', { x: 0, z: -1, yaw: 0, manual: true })
    const releasedCycle = actor.visualGait!.feet.left.cycle
    for (let i = 0; i < 60; i++) step(restIntent())
    expect(actor.visualGait!.feet.left.stance).toBe(true)
    expect(actor.visualGait!.feet.left.cycle).toBe(releasedCycle + 1)
    middle('right', { x: 0, z: -1, yaw: 1, manual: true })
    step({ x: 0, z: 1, yaw: 0, manual: true })
    for (let i = 0; i < 60; i++) step({ x: 0, z: 1, yaw: -1, manual: true })
    expect(minGap).toBeGreaterThanOrEqual(-.001)
    expect(maxSlip, JSON.stringify(worst)).toBeLessThanOrEqual(.01)
  })
  it.each(['release', 'reverse'])('keeps world contact targets through a middle-swing %s and resumed diagonal motion', action => {
    const actor = new ActorControl(profile), anchors = new Map<string, Vector3[]>()
    let changedAt = -1, maxSlip = 0, minGap = Infinity, minMiddle = Infinity, worst = {}
    for (let i = 0; i < 700; i++) {
      const middle = actor.visualGait!.feet.left
      if (changedAt < 0 && i > 50 && middle && !middle.stance && middle.phase >= .7 && middle.phase <= .8) changedAt = i
      const input = changedAt < 0 || i - changedAt > 180 ? { x: 1, z: -1, yaw: .2, manual: true }
        : action === 'release' ? restIntent() : { x: -1, z: 1, yaw: -.2, manual: true }
      actor.step(.005, input, null)
      for (const [side, sole] of Object.entries(soles(actor))) {
        const foot = actor.visualGait!.feet[side], gap = Math.min(...sole.points.map(p => p.y - .0001))
        minGap = Math.min(minGap, gap)
        if (foot.stance) {
          if (anchors.has(side)) {
            const slip = Math.max(...sole.points.map((p, n) => p.distanceTo(anchors.get(side)![n])))
            if (slip > maxSlip) worst = { i, changedAt, side, slip, root: actor.position.toArray(), foot: { at: foot.at.toArray(), to: foot.to.toArray(), phase: foot.phase, cycle: foot.cycle }, rendered: sole.points.map(p => p.toArray()) }
            maxSlip = Math.max(maxSlip, slip)
          }
          else anchors.set(side, sole.points.map(p => p.clone()))
        } else {
          anchors.delete(side)
          if (foot.phase >= .675 && foot.phase <= .825) minMiddle = Math.min(minMiddle, gap)
        }
      }
    }
    expect(changedAt).toBeGreaterThan(0)
    expect(maxSlip, JSON.stringify(worst)).toBeLessThanOrEqual(.01)
    expect(minGap).toBeGreaterThanOrEqual(-.001)
    expect(minMiddle).toBeGreaterThanOrEqual(.01)
  })
  it.each([Math.PI - .01, -Math.PI + .01])('seeded principal yaw %s and equivalent whole-turn headings produce the same world soles', principal => {
    const run = (yaw: number, seed: number) => {
      const actor = new ActorControl(profile); actor.yaw = yaw
      for (const chain of profile.chains.filter(c => c.group === 'legs')) {
        const p = forward(profile, neutral(profile)).get(chain.end)!.p.applyAxisAngle(up, yaw)
        actor.visualGait!.seed(chain.side < 0 ? 'left' : 'right', p, seed)
      }
      let previous: ReturnType<typeof soles> | null = null, max = 0
      for (let i = 0; i < 600; i++) {
        actor.step(.001, { x: 0, z: 0, yaw: 1, manual: true }, null)
        const next = soles(actor)
        if (previous) max = Math.max(max, displacement(previous, next))
        previous = next
      }
      return { max, pose: previous! }
    }
    const a = run(principal, principal), b = run(principal + Math.PI * 2, principal)
    expect(a.max).toBeLessThan(.005); expect(b.max).toBeLessThan(.005)
    expect(displacement(a.pose, b.pose)).toBeLessThan(1e-8)
  })
})
