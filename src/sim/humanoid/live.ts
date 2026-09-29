/** The driver lane's state machine. Practice actors never read these gates or joint caps. */
import { TIMING, type DriverCommand, type HumanoidDriver } from './drivers'
import { upperJoints } from './driver-profile'
import { neutral, type Angles } from './profile'
import {
  checklist,
  feedbackProblem,
  limitMotion,
  measuredPose,
  profileProblem,
  sweptCollision,
  targetProblem,
  type Motion,
  type TargetInput,
} from './safety'

export type LiveState = 'disconnected' | 'connecting' | 'observe' | 'arming' | 'live' | 'stopped' | 'fault'
export class LiveSession {
  state: LiveState = 'disconnected'
  reason = 'Choose a simulated driver'
  driver: HumanoidDriver | null = null
  twin: Angles = {}
  input: TargetInput = { kind: 'jog', token: 'jog', positions: {}, at: 0, valid: true, preset: false }
  confirmations = { mapping: false, workspace: false }
  held = false
  holdVerified = false
  onChange = () => {}
  private released = true
  private freshHeld = false
  private seq = 0
  private generation = 0
  private holdGeneration = 0
  private activeToken = ''
  private lastTick = 0
  private nextGoal = 0
  private armedAt = 0
  private holdId = ''
  private motion: Motion = { positions: {}, velocities: {} }
  constructor(private now = () => performance.now()) {}

  get active() {
    return this.state === 'live' || this.state === 'arming'
  }
  get checks() {
    const d = this.driver
    return d
      ? checklist(
          d.profile,
          d.read(),
          this.now(),
          this.input,
          this.twin,
          this.confirmations,
          this.holdVerified,
          this.held && this.freshHeld,
        )
      : []
  }
  async connect(driver: HumanoidDriver) {
    await this.disconnect()
    const generation = ++this.generation
    this.driver = driver
    this.state = 'connecting'
    this.reason = 'Opening an observe-only connection'
    this.held = this.freshHeld = this.holdVerified = false
    this.released = true
    this.confirmations = { mapping: false, workspace: false }
    this.seq = 0
    this.holdId = ''
    this.twin = neutral(driver.profile.rig)
    driver.onLost = (reason) => {
      if (this.driver === driver) void this.stop(reason, true)
    }
    this.onChange()
    try {
      const problem = profileProblem(driver.profile)
      if (typeof driver.hold !== 'function' || problem) throw new Error(problem || 'A mandatory hold is missing')
      await driver.connect()
      await this.hold(driver, 'Connected in observe-only mode')
      if (generation !== this.generation) {
        await driver.close()
        return false
      }
      this.holdVerified = true
      this.state = 'observe'
      this.reason = 'Observe only · twin follows measured joints'
      this.twin = measuredPose(driver.profile, driver.read(), this.twin)
      this.input = {
        kind: 'jog',
        token: 'jog',
        positions: { ...this.twin },
        at: this.now(),
        valid: true,
        preset: false,
      }
      this.lastTick = this.now()
      this.onChange()
      return true
    } catch (error) {
      if (generation === this.generation) {
        this.state = 'fault'
        this.reason = error instanceof Error ? error.message : 'Connection failed'
        this.onChange()
      }
      return false
    }
  }
  /** Only a new release/press edge can arm after a stop. Repeated keydown cannot rearm. */
  deadman(held: boolean) {
    if (held === this.held) return
    this.held = held
    if (!held) {
      this.released = true
      this.freshHeld = false
      if (this.active) void this.stop('Deadman released')
    } else if (this.released) {
      this.freshHeld = true
      this.released = false
    }
    this.onChange()
  }
  target(input: TargetInput) {
    this.input = { ...input, positions: { ...input.positions } }
    if (this.active && input.token !== this.activeToken) void this.stop('Input source changed; rearm is required', true)
  }
  goLive() {
    const driver = this.driver
    if (!driver || !['observe', 'stopped', 'fault'].includes(this.state)) return false
    const failed = this.checks.find((check) => !check.ok)
    if (failed) {
      this.reason = failed.reason
      this.onChange()
      return false
    }
    const now = this.now()
    this.motion = {
      positions: { ...this.twin },
      velocities: Object.fromEntries(upperJoints(driver.profile).map((j) => [j.id, 0])),
    }
    this.activeToken = this.input.token
    this.state = 'arming'
    this.reason = 'Waiting for guardian arm acknowledgement'
    this.armedAt = this.lastTick = this.nextGoal = now
    try {
      this.command('arm', now)
    } catch (error) {
      void this.stop(error instanceof Error ? error.message : 'Arm failed', true)
      return false
    }
    this.onChange()
    return true
  }
  private command(kind: DriverCommand['kind'], now: number) {
    this.driver!.send({
      kind,
      session: this.driver!.session,
      seq: ++this.seq,
      issuedAt: now,
      deadline: now + TIMING.lease,
      leaseUntil: now + TIMING.lease,
      ...(kind === 'goal' ? this.motion : {}),
    })
  }
  /** Called at 50 Hz. A delayed page must stop before it can renew an expired lease. */
  tick() {
    const driver = this.driver
    if (!driver || this.state === 'connecting') return
    const now = this.now(),
      elapsed = now - this.lastTick
    this.lastTick = now
    const read = driver.read()
    this.twin = measuredPose(driver.profile, read, this.twin)
    if (this.input.kind === 'jog') this.input.at = now
    if (!this.active) {
      this.onChange()
      return
    }
    const fail = (why: string) => {
      void this.stop(why, true)
    }
    if (!this.held || !this.freshHeld) {
      fail('Deadman is not held')
      return
    }
    if (elapsed > TIMING.lease || elapsed < 0) {
      fail('Page missed its deadman renewal')
      return
    }
    const feedback = feedbackProblem(driver.profile, read, now),
      target = targetProblem(driver.profile, this.input, now)
    if (feedback || target) {
      fail(feedback || target)
      return
    }
    if (this.input.token !== this.activeToken) {
      fail('Input source changed; rearm is required')
      return
    }
    if (this.state === 'arming') {
      if (read!.mode === 'live' && !read!.held) {
        this.state = 'live'
        this.reason = 'Live simulation · upper body only'
      } else if (now - this.armedAt > TIMING.acknowledgement) {
        fail('Guardian arm acknowledgement timed out')
        return
      } else return
    }
    if (read!.mode !== 'live' || read!.held) {
      fail('Guardian held; a fresh rearm is required')
      return
    }
    if (upperJoints(driver.profile).some((j) => Math.abs(this.motion.positions[j.id] - this.twin[j.id]) > 0.15)) {
      fail('Measured joints are not following the target')
      return
    }
    const next = limitMotion(driver.profile, this.motion, this.input.positions, Math.min(elapsed / 1000, 0.05))
    if (!next) {
      fail('The requested motion cannot meet the joint caps')
      return
    }
    // Passive joints always come from measurements, never from a camera or jog goal.
    for (const j of driver.profile.joints.filter((j) => j.group === 'legs')) next.positions[j.id] = this.twin[j.id]
    const collision = sweptCollision(driver.profile, this.twin, next.positions)
    if (collision) {
      fail(`Self-collision envelope: ${collision}`)
      return
    }
    this.motion = next
    try {
      this.command('lease', now)
      if (now >= this.nextGoal) {
        this.command('goal', now)
        this.nextGoal = Math.max(this.nextGoal + TIMING.goal, now)
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Driver send failed')
      return
    }
    this.onChange()
  }
  async stop(reason = 'Stopped', fault = false) {
    const driver = this.driver
    if (!driver) return
    if (!this.active && this.reason === reason && ['stopped', 'fault'].includes(this.state)) return
    const holdGeneration = ++this.holdGeneration
    this.state = fault ? 'fault' : 'stopped'
    this.reason = reason
    this.confirmations = { mapping: false, workspace: false }
    this.holdVerified = this.freshHeld = false
    this.released = !this.held
    this.motion = { positions: { ...this.twin }, velocities: {} }
    this.input = { ...this.input, positions: { ...this.twin }, at: this.now(), preset: false }
    this.onChange()
    try {
      await this.hold(driver, reason)
      if (this.driver === driver && this.holdGeneration === holdGeneration) this.holdVerified = true
    } catch {
      if (this.driver === driver && this.holdGeneration === holdGeneration) {
        this.state = 'fault'
        this.reason = `${reason} · hold acknowledgement missing`
      }
    }
    this.onChange()
  }
  /** Enforce the hold contract for every adapter, even one with a broken promise. */
  private async hold(driver: HumanoidDriver, reason: string) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const ack = await Promise.race([
        driver.hold(reason),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Hold acknowledgement timed out')), TIMING.acknowledgement)
        }),
      ])
      if (
        !ack ||
        typeof ack.id !== 'string' ||
        !ack.id ||
        ack.id === this.holdId ||
        ack.strategy !== driver.profile.stop ||
        !Number.isFinite(ack.at) ||
        this.now() - ack.at > TIMING.acknowledgement ||
        ack.at > this.now() + 1
      )
        throw new Error('Invalid hold acknowledgement')
      if (driver === this.driver) this.holdId = ack.id
    } finally {
      clearTimeout(timer)
    }
  }
  async disconnect() {
    ++this.generation
    if (this.driver) {
      await this.stop('Disconnected')
      const driver = this.driver
      driver.onLost = () => {}
      await driver.close()
    }
    this.driver = null
    this.state = 'disconnected'
    this.reason = 'Choose a simulated driver'
    this.held = this.freshHeld = this.holdVerified = false
    this.released = true
    this.onChange()
  }
}
