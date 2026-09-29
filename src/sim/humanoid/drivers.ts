/** Named-joint rosbridge contracts. No endpoint or hardware transport is selected implicitly. */
import { fromWire, profileKey, toWire, upperJoints, type DriverProfile } from './driver-profile'
import type { Angles } from './profile'
export type { DriverProfile } from './driver-profile'

export const TIMING = {
  feedback: 100,
  capture: 150,
  lease: 100,
  renewal: 20,
  guardian: 5,
  acknowledgement: 50,
  stable: 200,
  goal: 1000 / 30,
} as const
export interface JointReading {
  position: number | null
  at: number
  stamp: number
}
export interface DriverReading {
  session: string
  profileKey: string
  joints: Record<string, JointReading>
  at: number
  mode: 'hold' | 'ready' | 'live' | 'fault'
  stableSince: number
  guardian: boolean
  robotWatchdog: boolean
  exclusive: boolean
  fault: string
  held: boolean
}
export interface DriverCommand {
  kind: 'arm' | 'lease' | 'goal'
  session: string
  seq: number
  issuedAt: number
  deadline: number
  leaseUntil: number
  positions?: Angles
  velocities?: Angles
}
export interface HoldAck {
  id: string
  at: number
  strategy: DriverProfile['stop']
}
export interface HumanoidDriver {
  readonly profile: DriverProfile
  readonly session: string
  connect(): Promise<void>
  read(): DriverReading | null
  send(command: DriverCommand): void
  /** Required: discard pending motion and invoke the driver's configured hold/damp. */
  hold(reason: string): Promise<HoldAck>
  close(): Promise<void>
  onLost: (reason: string) => void
}
export interface BridgeTransport {
  open(): Promise<void>
  send(message: string): void
  close(): void
  onMessage: (message: string) => void
  onLost: (reason: string) => void
}
export const TOPIC = {
  goal: '/obpal/humanoid/goal',
  lease: '/obpal/humanoid/lease',
  state: '/joint_states',
  status: '/obpal/humanoid/status',
  open: '/obpal/humanoid/open',
  hold: '/obpal/humanoid/hold',
} as const
export interface Trajectory {
  joint_names: string[]
  points: { positions: number[]; velocities: number[]; time_from_start: { sec: number; nanosec: number } }[]
}
export const trajectory = (p: DriverProfile, q: Angles, velocity: Angles): Trajectory => {
  const joints = upperJoints(p)
  return {
    joint_names: joints.map((j) => j.wire),
    points: [
      {
        positions: joints.map((j) => toWire(j, q[j.id])),
        velocities: joints.map((j) => j.sign * velocity[j.id]),
        time_from_start: { sec: 0, nanosec: 100_000_000 },
      },
    ],
  }
}
export const stamp = (ms: number) => ({ sec: Math.floor(ms / 1000), nanosec: Math.floor((ms % 1000) * 1e6) })
const milliseconds = (s: unknown) => {
  const t = s as { sec?: number; nanosec?: number } | undefined
  return t && Number.isInteger(t.sec) && Number.isInteger(t.nanosec) && t.nanosec! >= 0 && t.nanosec! < 1e9
    ? t.sec! * 1000 + t.nanosec! / 1e6
    : NaN
}

/** A commissioned caller may supply a transport; the shipped UI supplies only a local Worker fake.
 * The guardian's hello establishes a monotonic clock offset with bounded round-trip uncertainty. */
export class RosbridgeDriver implements HumanoidDriver {
  session = ''
  onLost = (_reason: string) => {}
  private reading: DriverReading | null = null
  private joints: Record<string, JointReading> = {}
  private offset = 0
  private rosOffset = 0
  private uncertainty = Infinity
  private opened = false
  private statusSeq = -1
  private request = 0
  private holdId = ''
  private decoderFault = ''
  private pending = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  constructor(
    readonly profile: DriverProfile,
    readonly transport: BridgeTransport,
    private now = () => performance.now(),
  ) {}

  async connect() {
    this.session = crypto.randomUUID()
    this.joints = {}
    this.reading = null
    this.statusSeq = -1
    this.holdId = this.decoderFault = ''
    this.transport.onMessage = (data) => this.message(data)
    this.transport.onLost = (reason) => {
      this.opened = false
      this.onLost(reason)
    }
    try {
      await this.transport.open()
      this.opened = true
      this.uncertainty = Infinity
      // A cold page may compile shaders during a probe. Retry the observe-only
      // handshake, never relax the bound or retry a motion command.
      for (let attempt = 0; attempt < 3; attempt++) {
        const sent = this.now()
        const hello = await this.call(
          TOPIC.open,
          { session: this.session, profile_key: profileKey(this.profile), sent },
          1000,
        )
        const received = this.now(),
          uncertainty = (received - sent) / 2
        if (
          hello.session !== this.session ||
          hello.profile_key !== profileKey(this.profile) ||
          typeof hello.clock !== 'number' ||
          !Number.isFinite(hello.clock) ||
          typeof hello.ros_clock !== 'number' ||
          !Number.isFinite(hello.ros_clock)
        )
          throw new Error('Guardian profile could not be verified')
        if (uncertainty >= 0 && uncertainty <= 10) {
          this.uncertainty = uncertainty
          this.offset = hello.clock - (sent + received) / 2
          this.rosOffset = hello.ros_clock - hello.clock
          break
        }
      }
      if (!Number.isFinite(this.uncertainty)) throw new Error('Guardian clock could not be verified')
      for (const [topic, type] of [
        [TOPIC.goal, 'obpal_msgs/msg/GuardedTrajectory'],
        [TOPIC.lease, 'obpal_msgs/msg/DeadmanLease'],
      ])
        this.op({
          op: 'advertise',
          topic,
          type,
          latch: false,
          queue_size: 1,
          qos: { history: 'keep_last', depth: 1, reliability: 'reliable', durability: 'volatile' },
        })
      for (const [topic, type] of [
        [TOPIC.state, 'sensor_msgs/msg/JointState'],
        [TOPIC.status, 'obpal_msgs/msg/GuardianStatus'],
      ])
        this.op({ op: 'subscribe', topic, type, throttle_rate: 0, queue_length: 1 })
    } catch (error) {
      this.transport.close()
      this.opened = false
      throw error
    }
  }
  private op(message: object) {
    if (!this.opened) throw new Error('Driver connection is closed')
    this.transport.send(JSON.stringify(message))
  }
  private call(service: string, args: object, timeout: number) {
    const id = `${this.session}:${++this.request}`
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Guardian acknowledgement timed out'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.op({ op: 'call_service', service, id, args })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  private localTime(t: number) {
    return t - this.offset - this.uncertainty
  }
  private message(data: string) {
    if (typeof data !== 'string' || data.length > 100_000) return
    let m: {
      op?: string
      topic?: string
      id?: string
      result?: boolean
      values?: Record<string, unknown>
      msg?: Record<string, unknown>
    }
    try {
      m = JSON.parse(data)
    } catch {
      return
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      this.decoderFault = 'Malformed bridge response'
      return
    }
    if (m.op === 'service_response' && m.id) {
      const pending = this.pending.get(m.id)
      if (!pending) return
      this.pending.delete(m.id)
      clearTimeout(pending.timer)
      if (m.result !== true || !m.values) pending.reject(new Error('Guardian refused the request'))
      else pending.resolve(m.values)
      return
    }
    if (m.op !== 'publish' || !m.msg || !Number.isFinite(this.uncertainty)) return
    const v = m.msg
    if (m.topic === TOPIC.state) {
      const names = v.name,
        values = v.position
      const measured = milliseconds((v.header as { stamp?: unknown } | undefined)?.stamp)
      if (
        !Array.isArray(names) ||
        !Array.isArray(values) ||
        names.length !== values.length ||
        new Set(names).size !== names.length ||
        !Number.isFinite(measured) ||
        this.localTime(measured - this.rosOffset) > this.now() + 1
      ) {
        this.decoderFault = 'Malformed joint feedback'
        return
      }
      for (const j of this.profile.joints) {
        const index = names.indexOf(j.wire)
        if (index < 0) continue
        const old = this.joints[j.id]
        // Receipt of repeated measurements never refreshes their age.
        if (old && measured <= old.stamp) continue
        const raw = values[index]
        this.joints[j.id] = {
          position: typeof raw === 'number' && Number.isFinite(raw) ? fromWire(j, raw) : null,
          at: this.localTime(measured - this.rosOffset),
          stamp: measured,
        }
      }
    } else if (m.topic === TOPIC.status) {
      if (v.session !== this.session || !Number.isInteger(v.seq) || Number(v.seq) <= this.statusSeq) return
      if (
        typeof v.at !== 'number' ||
        !Number.isFinite(v.at) ||
        typeof v.stable_since !== 'number' ||
        !Number.isFinite(v.stable_since) ||
        typeof v.profile_key !== 'string' ||
        typeof v.held !== 'boolean' ||
        typeof v.mode !== 'string' ||
        !['hold', 'ready', 'live', 'fault'].includes(v.mode)
      ) {
        this.decoderFault = 'Malformed guardian status'
        return
      }
      this.statusSeq = Number(v.seq)
      this.reading = {
        session: this.session,
        profileKey: String(v.profile_key),
        joints: this.joints,
        at: this.localTime(v.at),
        // Stability needs the latest possible start; freshness uses the earliest.
        stableSince: v.stable_since - this.offset + this.uncertainty,
        mode: v.mode as DriverReading['mode'],
        guardian: v.guardian === true,
        robotWatchdog: v.robot_watchdog === true,
        exclusive: v.exclusive === true,
        fault: this.decoderFault || (typeof v.fault === 'string' ? v.fault : 'Missing controller fault state'),
        held: v.held === true,
      }
    }
  }
  read() {
    return this.reading
      ? {
          ...this.reading,
          fault: this.decoderFault || this.reading.fault,
          joints: Object.fromEntries(Object.entries(this.joints).map(([id, j]) => [id, { ...j }])),
        }
      : null
  }
  send(command: DriverCommand) {
    if (command.session !== this.session) throw new Error('Wrong driver session')
    const meta = {
      kind: command.kind,
      session: this.session,
      seq: command.seq,
      profile_key: profileKey(this.profile),
      hold_id: this.holdId,
      issued_at: command.issuedAt + this.offset,
      deadline: command.deadline + this.offset - this.uncertainty,
      lease_until: command.leaseUntil + this.offset - this.uncertainty,
    }
    this.op({
      op: 'publish',
      topic: command.kind === 'goal' ? TOPIC.goal : TOPIC.lease,
      msg: {
        ...meta,
        ...(command.kind === 'goal'
          ? { trajectory: trajectory(this.profile, command.positions!, command.velocities!) }
          : {}),
      },
    })
  }
  async hold(reason: string): Promise<HoldAck> {
    const ack = await this.call(
      TOPIC.hold,
      { session: this.session, reason, requested_at: this.now() + this.offset },
      TIMING.acknowledgement,
    )
    if (
      ack.session !== this.session ||
      typeof ack.id !== 'string' ||
      !ack.id ||
      typeof ack.at !== 'number' ||
      !Number.isFinite(ack.at) ||
      ack.strategy !== this.profile.stop ||
      ack.held !== true ||
      ack.id === this.holdId ||
      this.now() - this.localTime(ack.at) > TIMING.acknowledgement ||
      this.localTime(ack.at) > this.now() + 1
    )
      throw new Error('Invalid hold acknowledgement')
    this.holdId = ack.id
    return { id: ack.id, at: this.localTime(ack.at), strategy: this.profile.stop }
  }
  async close() {
    this.opened = false
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Driver closed'))
    }
    this.pending.clear()
    this.transport.close()
    this.reading = null
  }
}
