import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import {
  fakeProfile,
  fromWire,
  legRefusal,
  profileKey,
  toWire,
  upperJoints,
  type DriverKind,
} from '../src/sim/humanoid/driver-profile'
import {
  RosbridgeDriver,
  TIMING,
  TOPIC,
  trajectory,
  type BridgeTransport,
  type HumanoidDriver,
} from '../src/sim/humanoid/drivers'
import { FakeGuardian, type FakeFaults } from '../src/sim/humanoid/fake-guardian'
import { LiveSession } from '../src/sim/humanoid/live'
import {
  collisionProblem,
  feedbackProblem,
  limitMotion,
  profileProblem,
  segmentDistance,
  type Motion,
} from '../src/sim/humanoid/safety'
import { neutral } from '../src/sim/humanoid/profile'

async function fixture(kind: DriverKind = 'ros', rosEpoch = 0, timing = { settle: 220, helloDelay: 0 }) {
  let time = 1
  const now = () => time,
    wire: string[] = []
  let guardian: FakeGuardian
  const transport: BridgeTransport = {
    onMessage: () => {},
    onLost: () => {},
    open: async () => {},
    close: () => guardian.close(),
    send: (data) => {
      wire.push(data)
      if (timing.helloDelay) {
        try {
          if (JSON.parse(data)?.service === TOPIC.open) time += timing.helloDelay
        } catch {
          /* Malformed traffic must still reach the guardian. */
        }
      }
      guardian.receive(data)
    },
  }
  guardian = new FakeGuardian(kind, now, (message) => transport.onMessage(message))
  guardian.rosEpoch = rosEpoch
  const driver = new RosbridgeDriver(fakeProfile(kind), transport, now),
    live = new LiveSession(now)
  expect(await live.connect(driver)).toBe(true)
  const advance = (ms: number, page = true) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
      time += 10
      guardian.tick()
      if (page && Math.round(time) % 20 === 1) live.tick()
    }
  }
  advance(timing.settle)
  const arm = () => {
    advance(220)
    live.confirmations = { mapping: true, workspace: true }
    live.deadman(false)
    live.deadman(true)
    expect(live.goLive(), live.reason).toBe(true)
    advance(40)
    expect(live.state, live.reason).toBe('live')
  }
  const jog = (amount = 0.7) =>
    live.target({
      kind: 'jog',
      token: 'jog',
      positions: { ...live.twin, 'left.arm.elbow': amount },
      at: time,
      valid: true,
      preset: false,
    })
  const reconnect = async () => {
    await live.disconnect()
    guardian = new FakeGuardian(kind, now, (message) => transport.onMessage(message))
    const next = new RosbridgeDriver(fakeProfile(kind), transport, now)
    expect(await live.connect(next)).toBe(true)
    advance(220)
  }
  return {
    get guardian() {
      return guardian
    },
    driver,
    live,
    transport,
    wire,
    advance,
    arm,
    jog,
    now,
    jump: (ms: number) => {
      time += ms
    },
    reconnect,
  }
}

describe('humanoid driver fault matrix', () => {
  it('a late renewal cannot revive a lease between guardian polls', async () => {
    const f = await fixture()
    f.arm()
    f.jump(101)
    f.driver.send({
      kind: 'lease',
      session: f.driver.session,
      seq: 9999,
      issuedAt: f.now(),
      deadline: f.now() + 100,
      leaseUntil: f.now() + 100,
    })
    expect(f.guardian.held).toBe(true)
    expect(f.guardian.events.at(-1)?.reason).toBe('Deadman lease expired')
    await f.live.disconnect()
  })
  it('clock uncertainty cannot make the controller stability checklist pass early', async () => {
    const f = await fixture('ros', 0, { settle: 180, helloDelay: 20 })
    f.live.confirmations = { mapping: true, workspace: true }
    f.live.deadman(true)
    expect(f.live.goLive()).toBe(false)
    expect(f.live.reason).toContain('stable')
    f.advance(20)
    expect(f.live.goLive()).toBe(true)
    await f.live.disconnect()
  })
  it('does not treat an omitted guardian held flag as permission to move', async () => {
    const f = await fixture()
    f.arm()
    f.transport.onMessage(
      JSON.stringify({
        op: 'publish',
        topic: TOPIC.status,
        msg: {
          session: f.driver.session,
          seq: 9999,
          profile_key: profileKey(f.driver.profile),
          at: f.now(),
          stable_since: 0,
          mode: 'live',
          guardian: true,
          robot_watchdog: true,
          exclusive: true,
          fault: '',
        },
      }),
    )
    f.advance(40)
    expect(f.live.active).toBe(false)
    expect(f.live.reason).toContain('Malformed guardian status')
    expect(f.guardian.held).toBe(true)
    await f.live.disconnect()
  })
  it('requires a new 200 ms stable controller period after hold changes its mode', async () => {
    const f = await fixture()
    f.arm()
    await f.live.stop('Stop')
    f.live.confirmations = { mapping: true, workspace: true }
    f.live.deadman(false)
    f.live.deadman(true)
    expect(f.live.goLive()).toBe(false)
    expect(f.live.reason).toContain('stable')
    f.advance(200)
    expect(f.live.goLive()).toBe(true)
    await f.live.disconnect()
  })
  it('maps ROS epoch acquisition stamps onto the bounded monotonic clock', async () => {
    const f = await fixture('ros', 1_790_000_000_000)
    f.advance(10)
    expect(feedbackProblem(f.driver.profile, f.driver.read(), f.now())).toBe('')
    expect(f.driver.read()!.joints['left.arm.elbow'].at).toBeCloseTo(f.now())
    f.arm()
    await f.live.disconnect()
  })
  for (const jump of [-10_000, 10_000])
    it(`holds a ROS clock discontinuity of ${jump} ms`, async () => {
      const f = await fixture('ros', 1_790_000_000_000)
      f.arm()
      f.guardian.rosEpoch += jump
      f.advance(140)
      expect(f.live.active).toBe(false)
      expect(f.guardian.held).toBe(true)
      await f.live.disconnect()
    })
  for (const kind of ['ros', 'g1', 'h1'] as const) {
    it(`${kind}: observe-only follows measured joints and never sends a motion goal`, async () => {
      const f = await fixture(kind)
      f.guardian.pose['left.arm.elbow'] = 0.3
      f.advance(80)
      expect(f.live.twin['left.arm.elbow']).toBeCloseTo(0.3)
      expect(f.guardian.events.some((e) => e.kind === 'goal')).toBe(false)
      expect(f.live.state).toBe('observe')
      await f.live.disconnect()
    })
    it(`${kind}: Stop invokes its own strategy and blocks goals until a fresh release and rearm`, async () => {
      const f = await fixture(kind)
      f.arm()
      f.jog()
      f.advance(600)
      expect(f.guardian.events.filter((e) => e.kind === 'goal').length).toBeGreaterThan(8)
      await f.live.stop('Stop')
      const count = f.guardian.events.filter((e) => e.kind === 'goal').length
      f.advance(300)
      expect(f.guardian.events.filter((e) => e.kind === 'goal')).toHaveLength(count)
      expect(f.guardian.events.at(-1)?.strategy).toBe(f.driver.profile.stop)
      expect(f.live.goLive()).toBe(false)
      f.live.deadman(true)
      expect(f.live.goLive()).toBe(false)
      f.arm()
      await f.live.disconnect()
    })
    it(`${kind}: a release invokes hold without another motion goal`, async () => {
      const f = await fixture(kind)
      f.arm()
      f.jog()
      f.advance(300)
      const count = f.guardian.events.filter((e) => e.kind === 'goal').length
      f.live.deadman(false)
      f.advance(100)
      expect(f.guardian.held).toBe(true)
      expect(f.guardian.events.filter((e) => e.kind === 'goal')).toHaveLength(count)
      await f.live.disconnect()
    })
  }
  for (const [name, faults] of [
    ['one stale joint among fresh joints', { staleJoint: 'left.arm.elbow' }],
    ['all feedback frozen', { frozenFeedback: true }],
    ['an unreported joint', { unknownJoint: 'left.arm.elbow' }],
    ['a non-finite wire joint', { nanJoint: 'left.arm.elbow' }],
    ['an out-of-limit joint', { outOfLimits: 'left.arm.elbow' }],
    ['an unhealthy guardian', { guardianUnhealthy: true }],
    ['a missing robot watchdog', { robotWatchdogMissing: true }],
    ['a competing writer', { competingWriter: true }],
    ['a controller fault', { controllerFault: true }],
    ['a swapped joint map', { swappedMapping: true }],
  ] as [string, FakeFaults][]) {
    it(`refuses go-live with ${name}`, async () => {
      const f = await fixture()
      f.guardian.faults = faults
      f.advance(160)
      f.live.confirmations = { mapping: true, workspace: true }
      f.live.deadman(true)
      expect(f.live.goLive()).toBe(false)
      expect(f.guardian.events.some((e) => e.kind === 'goal')).toBe(false)
      await f.live.disconnect()
    })
    it(`holds active motion with ${name}`, async () => {
      const f = await fixture()
      f.arm()
      f.jog()
      f.advance(100)
      f.guardian.faults = faults
      f.advance(160)
      expect(f.live.active, f.live.reason).toBe(false)
      expect(f.guardian.held).toBe(true)
      const count = f.guardian.events.filter((e) => e.kind === 'goal').length
      f.advance(200)
      expect(f.guardian.events.filter((e) => e.kind === 'goal')).toHaveLength(count)
      await f.live.disconnect()
    })
  }
  it('name-based feedback accepts reordered arrays without swapping sides', async () => {
    const f = await fixture()
    f.guardian.faults.reverseNames = true
    f.guardian.pose['left.arm.elbow'] = 0.2
    f.guardian.pose['right.arm.elbow'] = 0.4
    f.advance(60)
    expect(f.live.twin['left.arm.elbow']).toBeCloseTo(0.2)
    expect(f.live.twin['right.arm.elbow']).toBeCloseTo(0.4)
    await f.live.disconnect()
  })
  it('repeating a measurement stamp does not refresh a single joint', async () => {
    const f = await fixture()
    const at = f.driver.read()!.joints['left.arm.elbow'].at
    f.guardian.faults.staleJoint = 'left.arm.elbow'
    f.advance(120)
    expect(f.driver.read()!.joints['left.arm.elbow'].at).toBe(at)
    expect(f.driver.read()!.joints['right.arm.elbow'].at).toBeGreaterThan(at)
    expect(feedbackProblem(f.driver.profile, f.driver.read(), f.now())).toContain('stale')
    await f.live.disconnect()
  })
  it('browser freeze expires the independent guardian lease within 110 ms', async () => {
    const f = await fixture()
    f.arm()
    f.jog()
    f.advance(100)
    f.advance(400, false)
    const hold = f.guardian.events.find((e) => e.reason === 'Deadman lease expired')!
    expect(hold.delay).toBeGreaterThanOrEqual(100)
    expect(hold.delay).toBeLessThanOrEqual(110)
    const count = f.guardian.events.filter((e) => e.kind === 'goal').length
    f.advance(100)
    expect(f.live.active).toBe(false)
    expect(f.guardian.events.filter((e) => e.kind === 'goal')).toHaveLength(count)
    await f.live.disconnect()
  })
  it('socket death and bridge death reach independent hold/watchdog paths', async () => {
    for (const fault of ['socketLost', 'bridgeDead'] as const) {
      const f = await fixture('h1')
      f.arm()
      f.advance(100)
      f.guardian.faults[fault] = true
      f.advance(300, false)
      const hold = f.guardian.events.filter((e) => e.kind === 'hold').at(-1)!
      expect(hold.delay).toBeLessThanOrEqual(110)
      expect(hold.strategy).toBe('controlled-damp')
      expect(f.guardian.held).toBe(true)
      // Restore the fake channel solely to dispose it without waiting for an ack timeout.
      f.guardian.faults = {}
      await f.live.disconnect()
    }
  })
  it('a missing hold acknowledgement latches a fault and prevents rearm', async () => {
    const f = await fixture()
    f.arm()
    f.guardian.faults.dropHoldAck = true
    await f.live.stop('Stop')
    expect(f.live.state).toBe('fault')
    expect(f.live.reason).toContain('acknowledgement missing')
    expect(f.guardian.held).toBe(true)
    f.live.deadman(false)
    f.live.deadman(true)
    expect(f.live.goLive()).toBe(false)
    f.guardian.faults = {}
    await f.live.disconnect()
  })
  it('reconnect returns to observe-only and clears confirmations and deadman', async () => {
    const f = await fixture()
    const session = f.live
    f.arm()
    await f.reconnect()
    expect(f.live).toBe(session)
    expect(session.state).toBe('observe')
    expect(session.held).toBe(false)
    expect(session.confirmations).toEqual({ mapping: false, workspace: false })
    expect(session.goLive()).toBe(false)
    expect(f.guardian.events.some((e) => e.kind === 'goal')).toBe(false)
    await session.disconnect()
  })
  for (const variant of [
    'replay',
    'deadline',
    'future',
    'future-issued',
    'old-token',
    'missing-joint',
    'leg',
    'velocity',
    'acceleration',
    'position-jump',
    'wrong-topic',
    'numeric-string',
    'nan',
  ] as const) {
    it(`guardian rejects ${variant} commands independently of the page gate`, async () => {
      const f = await fixture()
      f.arm()
      f.jog()
      f.advance(100)
      const last = JSON.parse(f.wire.filter((s) => JSON.parse(s).topic === TOPIC.goal).at(-1)!)
      const goal = last.msg
      goal.seq += 100
      goal.issued_at = f.now() + 20
      goal.deadline = goal.lease_until = f.now() + 100
      f.advance(20, false)
      if (variant === 'replay') goal.seq = 1
      if (variant === 'deadline') goal.deadline = f.now() - 1
      if (variant === 'future') goal.lease_until = f.now() + 101
      if (variant === 'future-issued') {
        goal.issued_at = f.now() + 10
        goal.deadline = goal.lease_until = f.now() + 110
      }
      if (variant === 'old-token') await f.live.stop('Stop')
      if (variant === 'missing-joint') goal.trajectory.joint_names.pop()
      if (variant === 'leg')
        goal.trajectory.joint_names[0] = f.driver.profile.joints.find((j) => j.group === 'legs')!.wire
      if (variant === 'velocity') goal.trajectory.points[0].velocities[0] = 2
      if (variant === 'acceleration') goal.trajectory.points[0].velocities[0] = 0.4
      if (variant === 'position-jump') goal.trajectory.points[0].positions[0] += 0.009
      if (variant === 'wrong-topic') last.topic = TOPIC.lease
      if (variant === 'numeric-string') goal.issued_at = String(goal.issued_at)
      if (variant === 'nan') goal.trajectory.points[0].positions[0] = null
      const count = f.guardian.events.filter((e) => e.kind === 'goal').length
      f.transport.send(JSON.stringify(last))
      expect(f.guardian.held).toBe(true)
      expect(f.guardian.events.at(-2)?.kind).toBe('reject')
      expect(f.guardian.events.filter((e) => e.kind === 'goal')).toHaveLength(count)
      await f.live.disconnect()
    })
  }
  for (const missing of ['mapping', 'workspace', 'deadman'] as const)
    it(`refuses an incomplete ${missing} checklist`, async () => {
      const f = await fixture()
      f.live.confirmations = { mapping: missing !== 'mapping', workspace: missing !== 'workspace' }
      f.live.deadman(missing !== 'deadman')
      expect(f.live.goLive()).toBe(false)
      expect(f.guardian.events.some((e) => e.kind === 'arm')).toBe(false)
      await f.live.disconnect()
    })
  for (const malformed of ['duplicate', 'future-stamp', 'null', 'bad-json'] as const)
    it(`rejects ${malformed} feedback without refreshing measurement age`, async () => {
      const f = await fixture(),
        before = f.driver.read()!.joints['left.arm.elbow'].at
      const wire = f.driver.profile.joints.find((j) => j.id === 'left.arm.elbow')!.wire
      const message = {
        op: 'publish',
        topic: TOPIC.state,
        msg: {
          header: { stamp: { sec: malformed === 'future-stamp' ? 99 : 0, nanosec: 0 } },
          name: [wire, wire],
          position: [0, 0],
        },
      }
      if (malformed === 'future-stamp') {
        message.msg.name.pop()
        message.msg.position.pop()
      }
      f.transport.onMessage(malformed === 'null' ? 'null' : malformed === 'bad-json' ? '{' : JSON.stringify(message))
      if (malformed !== 'bad-json') expect(f.driver.read()!.fault).not.toBe('')
      expect(f.driver.read()!.joints['left.arm.elbow'].at).toBe(before)
      await f.live.disconnect()
    })
  it('rejects malformed commands without crashing the guardian', async () => {
    for (const data of ['null', '[]', '{']) {
      const f = await fixture()
      f.arm()
      expect(() => f.transport.send(data)).not.toThrow()
      expect(f.guardian.held).toBe(true)
      await f.live.disconnect()
    }
  })
  it('enforces the hold deadline for a hung adapter and ignores a late acknowledgement', async () => {
    const f = await fixture()
    f.arm()
    const original = f.driver.hold.bind(f.driver)
    let finish: ((value: Awaited<ReturnType<typeof original>>) => void) | undefined
    f.driver.hold = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    await f.live.stop('Stop')
    expect(f.live.state).toBe('fault')
    expect(f.live.holdVerified).toBe(false)
    finish!({ id: 'late-ack', at: f.now(), strategy: f.driver.profile.stop })
    await Promise.resolve()
    expect(f.live.holdVerified).toBe(false)
    f.driver.hold = original
    await f.live.disconnect()
  })
  it('both the page trajectory and independent guardian refuse self-collision envelopes', async () => {
    const f = await fixture()
    f.arm()
    f.live.target({ ...f.live.input, positions: { ...f.live.twin, 'left.arm.roll': -0.26 } })
    f.advance(2000)
    expect(f.live.reason).toContain('Self-collision')
    expect(f.guardian.held).toBe(true)
    await f.reconnect()
    f.arm()
    f.guardian.pose['left.arm.roll'] = -0.26
    f.advance(20, false)
    expect(f.guardian.held).toBe(true)
    expect(f.guardian.events.filter((e) => e.kind === 'reject').at(-1)?.reason).toContain('approaches')
    await f.live.disconnect()
  })
  for (const condition of [
    'stale body',
    'occlusion',
    'generation',
    'preset',
    'NaN target',
    'misaligned twin',
    'stuck joint',
  ] as const) {
    it(`page holds or refuses ${condition}`, async () => {
      const f = await fixture()
      if (condition === 'misaligned twin') {
        f.live.twin['left.arm.elbow'] = 0.2
        f.live.confirmations = { mapping: true, workspace: true }
        f.live.deadman(true)
        expect(f.live.goLive()).toBe(false)
      } else {
        f.arm()
        f.jog()
        if (condition === 'stuck joint') {
          f.guardian.faults.stuck = true
          f.advance(2000)
        } else {
          const input = { ...f.live.input, positions: { ...f.live.input.positions } }
          if (condition === 'stale body') {
            input.kind = 'body'
            input.at = f.now() - 151
          }
          if (condition === 'occlusion') input.valid = false
          if (condition === 'generation') input.token = 'new-generation'
          if (condition === 'preset') input.preset = true
          if (condition === 'NaN target') input.positions['left.arm.elbow'] = NaN
          f.live.target(input)
          f.advance(40)
        }
        expect(f.live.active, f.live.reason).toBe(false)
        expect(f.guardian.held).toBe(true)
      }
      await f.live.disconnect()
    })
  }
})

describe('humanoid profiles and motion constraints', () => {
  it('keeps G1 arm7 and H1 arm4 indices and unsupported wrists separate', () => {
    const g = fakeProfile('g1'),
      h = fakeProfile('h1')
    expect(g.joints.find((j) => j.id === 'left.arm.pitch')?.index).toBe(15)
    expect(h.joints.find((j) => j.id === 'left.arm.pitch')?.index).toBe(16)
    expect(upperJoints(g)).toHaveLength(17)
    expect(upperJoints(h)).toHaveLength(9)
    expect(h.joints.some((j) => j.id.includes('wrist'))).toBe(false)
    expect(profileKey(g)).not.toBe(profileKey(h))
    for (const p of [g, h, fakeProfile('ros')])
      for (const j of p.joints) expect(fromWire(j, toWire(j, 0.3))).toBeCloseTo(0.3)
  })
  it('refuses physical leg enable even when a caller supplies an unverified evidence string', () => {
    const p = fakeProfile('ros')
    expect(legRefusal(p)).toContain('no commissioned')
    p.legs.capable = true
    expect(legRefusal(p)).toContain('evidence is required')
    p.legs.commissioning = 'unverified'
    expect(legRefusal(p)).toContain('cannot be verified')
    const q = neutral(p.rig),
      message = trajectory(p, q, q)
    expect(message.joint_names.some((name) => name.includes('leg'))).toBe(false)
  })
  it('rejects invalid maps, units, limits, excessive caps and missing hold at runtime', async () => {
    for (const corrupt of ['duplicate', 'units', 'limit', 'speed', 'acceleration', 'sign', 'leg-group']) {
      const p = fakeProfile('ros')
      if (corrupt === 'duplicate') p.joints[0].wire = p.joints[1].wire
      if (corrupt === 'units') (p as unknown as { units: string }).units = 'degrees'
      if (corrupt === 'limit') p.joints[0].limits[0] = -999
      if (corrupt === 'speed') p.joints[0].speed = 1
      if (corrupt === 'acceleration') p.joints[0].acceleration = 2
      if (corrupt === 'sign') (p.joints[0] as { sign: number }).sign = 0
      if (corrupt === 'leg-group') p.joints.find((j) => j.group === 'legs')!.group = 'upper'
      expect(profileProblem(p)).not.toBe('')
    }
    const f = await fixture()
    await f.live.disconnect()
    const bad = { profile: fakeProfile('ros'), onLost: () => {}, close: async () => {} } as unknown as HumanoidDriver
    expect(await f.live.connect(bad)).toBe(false)
    expect(f.live.reason).toContain('hold')
  })
  for (const kind of ['ros', 'g1', 'h1'] as const)
    it(`${kind}: joint motion is finite and obeys speed and acceleration caps`, () => {
      const p = fakeProfile(kind),
        q = neutral(p.rig)
      let state: Motion = { positions: q, velocities: {} }
      for (let step = 0; step < 1500; step++) {
        const desired = Object.fromEntries(p.joints.map((j) => [j.id, step < 600 ? j.limits[1] : j.limits[0]]))
        const next = limitMotion(p, state, desired, 0.02)
        expect(next, `step ${step}`).not.toBeNull()
        for (const j of upperJoints(p)) {
          expect(next!.positions[j.id]).toBeGreaterThanOrEqual(j.limits[0] - 1e-9)
          expect(next!.positions[j.id]).toBeLessThanOrEqual(j.limits[1] + 1e-9)
          expect(Math.abs(next!.velocities[j.id])).toBeLessThanOrEqual(j.speed + 1e-9)
          expect(Math.abs(next!.velocities[j.id] - (state.velocities[j.id] ?? 0))).toBeLessThanOrEqual(
            j.acceleration * 0.02 + 1e-9,
          )
        }
        state = next!
      }
    })
  it('capsules handle points, parallel segments and crossing segments', () => {
    const p = (x: number, y: number, z = 0) => new Vector3(x, y, z)
    expect(segmentDistance(p(0, 0), p(1, 0), p(0.5, -1), p(0.5, 1))).toBeCloseTo(0)
    expect(segmentDistance(p(0, 0), p(1, 0), p(0, 2), p(1, 2))).toBeCloseTo(2)
    expect(segmentDistance(p(0, 0), p(0, 0), p(0, 2), p(0, 2))).toBeCloseTo(2)
    const profile = fakeProfile('ros'),
      q = neutral(profile.rig)
    expect(collisionProblem(profile, q)).toContain('leg')
    q['left.arm.roll'] = q['right.arm.roll'] = 0.25
    expect(collisionProblem(profile, q)).toBe('')
    q['left.arm.roll'] = -0.26
    expect(collisionProblem(profile, q)).not.toBe('')
  })
  it('timing constants retain the reviewed lease, feedback and hold bounds', () => {
    expect(TIMING).toMatchObject({
      lease: 100,
      guardian: 5,
      renewal: 20,
      acknowledgement: 50,
      feedback: 100,
      capture: 150,
    })
  })
})
