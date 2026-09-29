/** A deterministic simulated guardian and robot watchdog. This code never talks to hardware. */
import { fakeProfile, fromWire, profileKey, toWire, upperJoints, type DriverKind } from './driver-profile'
import { TIMING, TOPIC, stamp, type DriverReading, type Trajectory } from './drivers'
import { neutral, type Angles } from './profile'
import { collisionProblem, feedbackProblem, sweptCollision } from './safety'

export interface FakeFaults {
  staleJoint?: string
  unknownJoint?: string
  nanJoint?: string
  outOfLimits?: string
  frozenFeedback?: boolean
  guardianUnhealthy?: boolean
  robotWatchdogMissing?: boolean
  competingWriter?: boolean
  controllerFault?: boolean
  dropHoldAck?: boolean
  socketLost?: boolean
  bridgeDead?: boolean
  swappedMapping?: boolean
  reverseNames?: boolean
  stuck?: boolean
}
export interface DriverEvent {
  kind: 'arm' | 'goal' | 'hold' | 'reject'
  at: number
  reason?: string
  strategy?: string
  delay?: number
  seq?: number
  positions?: Angles
  velocities?: Angles
}
export class FakeGuardian {
  readonly profile
  readonly events: DriverEvent[] = []
  faults: FakeFaults = {}
  pose: Angles
  rosEpoch = 0
  session = ''
  held = true
  holdId = ''
  private holdCount = 0
  private seq = -1
  private statusSeq = 0
  private since: number
  private lastMode: DriverReading['mode'] = 'hold'
  private measured: Record<string, { position: number | null; at: number; stamp: number }> = {}
  private nextFeedback = 0
  private leaseUntil = -Infinity
  private lastRenewal = 0
  private robotFed = 0
  private lastGoalAt = 0
  private lastGoal: Angles
  private velocity: Angles = {}
  private fault = ''
  private topics = new Set<string>()
  constructor(
    kind: DriverKind,
    private now: () => number,
    private emit: (message: string) => void,
  ) {
    this.profile = fakeProfile(kind)
    this.pose = neutral(this.profile.rig)
    // Keep the measured rest pose clear of the conservative thigh capsules.
    this.pose['left.arm.roll'] = this.pose['right.arm.roll'] = 0.25
    this.lastGoal = { ...this.pose }
    this.since = now()
    this.measure()
  }
  private key() {
    if (!this.faults.swappedMapping) return profileKey(this.profile)
    const changed = structuredClone(this.profile)
    const [a, b] = changed.joints
    ;[a.wire, b.wire] = [b.wire, a.wire]
    return profileKey(changed)
  }
  private send(message: object) {
    if (!this.faults.socketLost && !this.faults.bridgeDead) this.emit(JSON.stringify(message))
  }
  private record(event: DriverEvent) {
    this.events.push(event)
    if (this.events.length > 4000) this.events.shift()
  }
  private measure() {
    const now = this.now()
    for (const j of this.profile.joints) {
      if ((this.faults.frozenFeedback || this.faults.staleJoint === j.id) && this.measured[j.id]) continue
      const position =
        this.faults.unknownJoint === j.id || this.faults.nanJoint === j.id
          ? null
          : this.faults.outOfLimits === j.id
            ? j.limits[1] + 0.2
            : this.pose[j.id]
      this.measured[j.id] = { position, at: now, stamp: now }
    }
  }
  private reading(): DriverReading {
    const mode = this.fault || this.faults.controllerFault ? 'fault' : this.held ? 'hold' : 'live'
    if (mode !== this.lastMode) {
      this.lastMode = mode
      this.since = this.now()
    }
    return {
      session: this.session,
      profileKey: this.key(),
      joints: this.measured,
      at: this.now(),
      mode,
      stableSince: this.since,
      guardian: !this.faults.guardianUnhealthy,
      robotWatchdog: !this.faults.robotWatchdogMissing,
      exclusive: !this.faults.competingWriter,
      fault: this.fault || (this.faults.controllerFault ? 'Controller fault' : ''),
      held: this.held,
    }
  }
  private status() {
    if (!this.topics.has(TOPIC.status)) return
    const read = this.reading()
    this.send({
      op: 'publish',
      topic: TOPIC.status,
      msg: {
        session: this.session,
        profile_key: read.profileKey,
        seq: ++this.statusSeq,
        at: read.at,
        stable_since: read.stableSince,
        mode: read.mode,
        guardian: read.guardian,
        robot_watchdog: read.robotWatchdog,
        exclusive: read.exclusive,
        fault: read.fault,
        held: read.held,
      },
    })
  }
  private states() {
    if (!this.topics.has(TOPIC.state)) return
    // Standard JointState batches share a measurement stamp. A stale joint keeps
    // its own older stamp even while every other joint reports fresh readings.
    const batches = new Map<number, typeof this.profile.joints>()
    for (const j of this.profile.joints) {
      const time = this.measured[j.id].stamp
      const batch = batches.get(time) ?? []
      batch.push(j)
      batches.set(time, batch)
    }
    for (const [time, batch] of batches) {
      if (this.faults.reverseNames) batch.reverse()
      this.send({
        op: 'publish',
        topic: TOPIC.state,
        msg: {
          header: { stamp: stamp(time + this.rosEpoch) },
          name: batch.map((j) => j.wire),
          position: batch.map((j) =>
            this.measured[j.id].position === null ? null : toWire(j, this.measured[j.id].position!),
          ),
          velocity: [],
          effort: [],
        },
      })
    }
  }
  private hold(reason: string, trigger = this.now()) {
    this.held = true
    this.holdId = `${this.session}:hold:${++this.holdCount}`
    this.leaseUntil = -Infinity
    this.lastGoal = { ...this.pose }
    this.velocity = {}
    this.record({
      kind: 'hold',
      at: this.now(),
      reason,
      strategy: this.profile.stop,
      delay: Math.max(0, this.now() - trigger),
    })
    this.status()
  }
  private reject(reason: string) {
    this.fault = reason
    this.record({ kind: 'reject', at: this.now(), reason })
    this.hold(reason)
  }
  /** Runs independently of the page at 5 ms intervals in the Worker harness. */
  tick() {
    const now = this.now()
    if (this.faults.bridgeDead) {
      if (!this.held && !this.faults.robotWatchdogMissing && now - this.robotFed >= TIMING.lease)
        this.hold('Robot watchdog: bridge lost', this.robotFed)
      return
    }
    this.robotFed = now
    if (now >= this.nextFeedback) {
      this.nextFeedback = now + TIMING.renewal
      this.measure()
      this.states()
      this.status()
    }
    if (!this.held) {
      const problem = feedbackProblem(this.profile, this.reading(), now) || collisionProblem(this.profile, this.pose)
      if (problem) this.reject(problem)
      else if (now >= this.leaseUntil) this.hold('Deadman lease expired', this.lastRenewal)
    }
  }
  receive(data: string) {
    if (this.faults.bridgeDead || this.faults.socketLost || data.length > 100_000) return
    let message: {
      op?: string
      id?: string
      service?: string
      topic?: string
      args?: Record<string, unknown>
      msg?: Record<string, unknown>
    }
    try {
      message = JSON.parse(data)
    } catch {
      this.reject('Malformed bridge message')
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.reject('Malformed bridge message')
      return
    }
    const args = message.args ?? {}
    const respond = (values: object, result = true) =>
      this.send({ op: 'service_response', id: message.id, service: message.service, result, values })
    if (message.op === 'call_service') {
      if (message.service === TOPIC.open) {
        if (
          (this.session && args.session !== this.session) ||
          typeof args.session !== 'string' ||
          !args.session ||
          args.profile_key !== this.key()
        ) {
          respond({}, false)
          return
        }
        if (!this.session) this.since = this.now()
        this.session = args.session
        const clock = this.now()
        respond({ session: this.session, profile_key: this.key(), clock, ros_clock: clock + this.rosEpoch })
      } else if (message.service === TOPIC.hold) {
        if (args.session !== this.session) {
          respond({}, false)
          return
        }
        this.fault = ''
        this.hold(String(args.reason), typeof args.requested_at === 'number' ? args.requested_at : this.now())
        if (!this.faults.dropHoldAck)
          respond({ session: this.session, id: this.holdId, at: this.now(), strategy: this.profile.stop, held: true })
      }
      return
    }
    if (message.op === 'subscribe' && message.topic) {
      this.topics.add(message.topic)
      this.states()
      this.status()
      return
    }
    if (message.op === 'advertise') return
    if (message.op !== 'publish' || ![TOPIC.goal, TOPIC.lease].includes(message.topic as typeof TOPIC.goal)) return
    const m = message.msg ?? {},
      now = this.now()
    if ((m.kind === 'goal') !== (message.topic === TOPIC.goal)) {
      this.reject('Wrong command topic')
      return
    }
    if (m.session !== this.session || m.profile_key !== this.key() || m.hold_id !== this.holdId) {
      this.reject('Session, profile or rearm token mismatch')
      return
    }
    if (!Number.isInteger(m.seq) || Number(m.seq) <= this.seq) {
      this.reject('Replayed command')
      return
    }
    const issued = m.issued_at as number,
      deadline = m.deadline as number,
      lease = m.lease_until as number
    if (
      ![issued, deadline, lease].every((n) => typeof n === 'number' && Number.isFinite(n)) ||
      issued > now + 10 ||
      now - issued > TIMING.lease ||
      deadline <= now ||
      lease <= now ||
      deadline > issued + TIMING.lease + 0.01 ||
      deadline > now + TIMING.lease + 0.01 ||
      lease > now + TIMING.lease + 0.01 ||
      lease > issued + TIMING.lease + 0.01
    ) {
      this.reject('Expired or invalid command deadline')
      return
    }
    // A renewal arriving between watchdog polls cannot revive an expired lease.
    if (!this.held && now >= this.leaseUntil) {
      this.hold('Deadman lease expired', this.lastRenewal)
      return
    }
    this.seq = Number(m.seq)
    const problem = feedbackProblem(this.profile, this.reading(), now)
    if (problem) {
      this.reject(problem)
      return
    }
    if (m.kind === 'arm') {
      if (!this.held || now - this.since < TIMING.stable || collisionProblem(this.profile, this.pose)) {
        this.reject('Controller is not ready to arm')
        return
      }
      this.held = false
      this.lastGoal = { ...this.pose }
      this.lastGoalAt = issued
      this.velocity = Object.fromEntries(upperJoints(this.profile).map((j) => [j.id, 0]))
      this.robotFed = now
      this.record({ kind: 'arm', at: now, seq: this.seq })
    } else if (this.held) {
      this.reject('Motion remains latched off')
      return
    } else if (m.kind === 'goal') {
      const trajectory = m.trajectory as Trajectory | undefined,
        point = trajectory?.points?.[0]
      const names = trajectory?.joint_names,
        expected = upperJoints(this.profile)
      if (
        !Array.isArray(names) ||
        new Set(names).size !== expected.length ||
        names.length !== expected.length ||
        expected.some((j) => !names.includes(j.wire)) ||
        trajectory?.points?.length !== 1 ||
        !point ||
        !Array.isArray(point.positions) ||
        !Array.isArray(point.velocities) ||
        point.positions.length !== names.length ||
        point.velocities.length !== names.length ||
        point.time_from_start?.sec !== 0 ||
        point.time_from_start?.nanosec !== 100_000_000
      ) {
        this.reject('A complete upper-body trajectory is required; legs are locked')
        return
      }
      const q = { ...this.pose },
        velocity: Angles = {},
        dt = (issued - this.lastGoalAt) / 1000
      if (!(dt > 0 && dt <= 0.1)) {
        this.reject('Invalid goal cadence')
        return
      }
      for (const j of expected) {
        const i = names.indexOf(j.wire),
          position = point.positions[i],
          speed = point.velocities[i]
        if (![position, speed].every((n) => typeof n === 'number' && Number.isFinite(n))) {
          this.reject('Non-finite goal')
          return
        }
        q[j.id] = fromWire(j, position)
        velocity[j.id] = speed * j.sign
        if (
          q[j.id] < j.limits[0] ||
          q[j.id] > j.limits[1] ||
          Math.abs(speed) > j.speed + 1e-8 ||
          Math.abs(q[j.id] - this.lastGoal[j.id]) > j.speed * dt + 1e-7 ||
          Math.abs(q[j.id] - this.lastGoal[j.id] - (this.velocity[j.id] ?? 0) * dt) > j.acceleration * dt * dt + 1e-7 ||
          Math.abs(velocity[j.id] - (this.velocity[j.id] ?? 0)) > j.acceleration * dt + 1e-7
        ) {
          this.reject('Joint, speed or acceleration cap exceeded')
          return
        }
      }
      const collision = sweptCollision(this.profile, this.pose, q)
      if (collision) {
        this.reject(`Self-collision envelope: ${collision}`)
        return
      }
      this.lastGoal = q
      this.velocity = velocity
      this.lastGoalAt = issued
      if (!this.faults.stuck) this.pose = { ...q }
      this.record({ kind: 'goal', at: now, seq: this.seq, positions: { ...q }, velocities: { ...velocity } })
    } else if (m.kind !== 'lease') {
      this.reject('Unknown command')
      return
    }
    this.lastRenewal = now
    this.leaseUntil = Math.min(lease, deadline, now + TIMING.lease)
    this.status()
  }
  close() {
    this.hold('Connection closed')
  }
  snapshot() {
    return {
      held: this.held,
      holdId: this.holdId,
      session: this.session,
      events: this.events,
      pose: this.pose,
      strategy: this.profile.stop,
    }
  }
}
