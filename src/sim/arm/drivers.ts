/**
 * Real arms behind the sim (CATALOGUE §7, system.robot-arm). The sim stays the digital twin: it runs the safety
 * envelope and the joint limits, and a driver copies the twin's joints to the hardware while the screen has the arm
 * live. Before that, the twin follows what the arm reports, so going live never jumps.
 *
 *  - Feetech bus servos (the SO-100 and SO-101 arms) over USB, with Web Serial: Chrome or Edge on a computer.
 *  - The ob.Pal serial protocol over USB, for any arm with a microcontroller: hardware/arduino/obpal-arm is the
 *    reference sketch, for hobby servos.
 *  - ROS 2 through rosbridge, for an arm anywhere a WebSocket reaches: ws://localhost from this page, wss://
 *    across a network.
 *
 * Six joints, in the sim's order: base, shoulder, elbow, wrist, roll (degrees) and the gripper (0 closed … 1 open).
 * Each driver speaks its own raw units; a Calibration maps between them.
 */
import { positionOf, readPosition, STS, syncGoals, syncTorque, takeStatus } from './feetech'

export type DriverKind = 'feetech' | 'serial' | 'ros'
export const JOINT_COUNT = 6

export interface Calibration {
  /** Raw value at the sim's 0° for joints 0–4. */
  zero: number[]
  /** 1 or -1: which way the joint turns for a positive angle. */
  dir: number[]
  /** Raw units per degree. */
  perDeg: number
  gripClosed: number
  gripOpen: number
}

export function defaultCalibration(kind: DriverKind): Calibration {
  if (kind === 'feetech') return { zero: [2048, 2048, 2048, 2048, 2048], dir: [1, 1, 1, 1, 1], perDeg: STS.turn / 360, gripClosed: 2048, gripOpen: 3100 }
  if (kind === 'ros') return { zero: [0, 0, 0, 0, 0], dir: [1, 1, 1, 1, 1], perDeg: Math.PI / 180, gripClosed: 0, gripOpen: 1 }
  return { zero: [0, 0, 0, 0, 0], dir: [1, 1, 1, 1, 1], perDeg: 1, gripClosed: 0, gripOpen: 1 }
}

/** Sim values (degrees, gripper 0–1) to the driver's raw units. */
export function toRaw(c: Calibration, sim: number[]): number[] {
  return sim.map((v, i) => (i < 5 ? c.zero[i] + c.dir[i] * v * c.perDeg : c.gripClosed + v * (c.gripOpen - c.gripClosed)))
}

export function fromRaw(c: Calibration, raw: number[]): number[] {
  return raw.map((r, i) => (i < 5 ? (r - c.zero[i]) / (c.dir[i] * c.perDeg) : (c.gripOpen === c.gripClosed ? 0 : (r - c.gripClosed) / (c.gripOpen - c.gripClosed))))
}

/** Calibrate from the arm posed like the sim's home pose: the raw readings become those angles (and the gripper open). */
export function calibrateHome(c: Calibration, raw: number[], home: number[]): Calibration {
  return { ...c, zero: c.zero.map((_, i) => raw[i] - c.dir[i] * home[i] * c.perDeg), gripOpen: raw[5] }
}

export interface ArmDriver {
  readonly kind: DriverKind
  /** What it's connected to, for the screen. */
  label: string
  /** Whether read() measures the arm (encoders) or repeats what the device was last told. */
  readonly feedback: 'measured' | 'commanded'
  /** Open the connection. Serial drivers ask for a port, so call this from a click. */
  connect(): Promise<void>
  /** The latest raw positions the arm reported (one per joint, null if unknown), and when (performance.now()). */
  read(): { raw: (number | null)[]; at: number } | null
  /** Command raw positions. Called only while the screen has the arm live. */
  send(raw: number[]): void
  /** Hold (true) or go limp (false), where the hardware allows. */
  torque(on: boolean): Promise<void>
  close(): Promise<void>
  /** The connection dropped by itself (cable pulled, socket closed). */
  onLost?: (why: string) => void
}

// ---- Web Serial, typed just enough (Chrome, Edge) ----

interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>
  close(): Promise<void>
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
  getInfo?(): { usbVendorId?: number; usbProductId?: number }
}
interface SerialLike { requestPort(o?: object): Promise<SerialPortLike> }
const serialApi = () => (navigator as Navigator & { serial?: SerialLike }).serial
export const hasSerial = () => !!serialApi()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A serial port with a byte queue in and a write lock out. */
class Port {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private closed = false
  onBytes?: (b: Uint8Array) => void
  onLost?: (why: string) => void

  constructor(private port: SerialPortLike) {}

  static async ask(baud: number): Promise<Port> {
    const api = serialApi()
    if (!api) throw new Error('This browser can’t reach USB serial: use Chrome or Edge on a computer')
    const p = await api.requestPort()
    await p.open({ baudRate: baud })
    const port = new Port(p)
    port.start()
    return port
  }

  get name() {
    const i = this.port.getInfo?.()
    return i?.usbVendorId ? `USB ${i.usbVendorId.toString(16).padStart(4, '0')}:${(i.usbProductId ?? 0).toString(16).padStart(4, '0')}` : 'USB serial'
  }

  private start() {
    this.writer = this.port.writable!.getWriter()
    this.reader = this.port.readable!.getReader()
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader!.read()
          if (done) break
          if (value?.length) this.onBytes?.(value)
        }
      } catch (e) {
        if (!this.closed) this.onLost?.(e instanceof Error ? e.message : 'the port closed')
        return
      }
      if (!this.closed) this.onLost?.('the port closed')
    })()
  }

  async write(b: Uint8Array) { if (!this.closed) await this.writer!.write(b) }

  async close() {
    if (this.closed) return
    this.closed = true
    try { await this.reader?.cancel() } catch { /* already gone */ }
    try { this.reader?.releaseLock() } catch { /* already released */ }
    try { await this.writer?.close() } catch { /* already gone */ }
    try { await this.port.close() } catch { /* already closed */ }
  }
}

/** Serialises access to a half-duplex bus: one request (and its reply) at a time. */
class Lock {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(f: () => Promise<T>): Promise<T> {
    const next = this.tail.then(f, f)
    this.tail = next.catch(() => {})
    return next
  }
}

// ---- Feetech STS (SO-100, SO-101): servo ids 1–6 in the sim's joint order ----

export class FeetechDriver implements ArmDriver {
  readonly kind = 'feetech'
  readonly feedback = 'measured'
  label = 'Feetech bus'
  onLost?: (why: string) => void
  private port: Port | null = null
  private bus = new Lock()
  private rx: number[] = []
  private waiting: { id: number; echo: Uint8Array; resolve: (v: number | null) => void } | null = null
  private raw: (number | null)[] = Array(JOINT_COUNT).fill(null)
  private at = 0
  private polling = false
  private lastSend = 0

  constructor(readonly ids: number[] = [1, 2, 3, 4, 5, 6]) {}

  async connect() {
    this.port = await Port.ask(STS.baud)
    this.port.onBytes = (b) => this.bytes(b)
    this.port.onLost = (why) => { this.polling = false; this.onLost?.(why) }
    // Anyone there?
    const found: number[] = []
    for (const id of this.ids) if ((await this.readOne(id)) !== null) found.push(id)
    if (!found.length) { await this.close(); throw new Error('No servos answered at 1 Mbaud. Is the arm powered, and is this its port?') }
    this.label = `Feetech · ${found.length} of ${this.ids.length} servos · ${this.port.name}`
    this.polling = true
    void this.poll()
  }

  private bytes(b: Uint8Array) {
    for (const x of b) this.rx.push(x)
    for (;;) {
      const r = takeStatus(this.rx)
      if (!r) break
      const pkt = this.rx.splice(0, r.used)
      const w = this.waiting
      if (!r.status || !w) continue
      // Adapters that echo what we send: our own request comes back first.
      if (pkt.length >= w.echo.length && w.echo.every((v, i) => pkt[pkt.length - w.echo.length + i] === v)) continue
      if (r.status.id === w.id) { this.waiting = null; w.resolve(positionOf(r.status)) }
    }
    if (this.rx.length > 512) this.rx.splice(0, this.rx.length - 64)
  }

  private readOne(id: number): Promise<number | null> {
    return this.bus.run(async () => {
      const req = readPosition(id)
      const reply = new Promise<number | null>((resolve) => { this.waiting = { id, echo: req, resolve } })
      await this.port!.write(req)
      const v = await Promise.race([reply, sleep(30).then(() => null)])
      if (this.waiting?.id === id) this.waiting = null
      return v
    })
  }

  /** Read every servo about ten times a second. */
  private async poll() {
    while (this.polling) {
      const t0 = performance.now()
      for (let i = 0; i < this.ids.length && this.polling; i++) {
        const v = await this.readOne(this.ids[i])
        if (v !== null) this.raw[i] = v
      }
      this.at = performance.now()
      await sleep(Math.max(0, 100 - (performance.now() - t0)))
    }
  }

  read() { return this.at ? { raw: [...this.raw], at: this.at } : null }

  send(raw: number[]) {
    const now = performance.now()
    if (!this.port || now - this.lastSend < 20) return
    this.lastSend = now
    const pkt = syncGoals(raw.map((pos, i) => ({ id: this.ids[i], pos })))
    void this.bus.run(() => this.port!.write(pkt)).catch(() => {})
  }

  async torque(on: boolean) {
    if (!this.port) return
    // Before holding, aim each servo where it is, so switching torque on never jumps.
    if (on && this.raw.every((v) => v !== null)) await this.bus.run(() => this.port!.write(syncGoals(this.raw.map((pos, i) => ({ id: this.ids[i], pos: pos! })))))
    await this.bus.run(() => this.port!.write(syncTorque(this.ids, on)))
  }

  async close() {
    this.polling = false
    const p = this.port
    this.port = null
    await p?.close()
  }
}

// ---- The ob.Pal serial protocol: lines of text at 115200 baud (hardware/arduino/obpal-arm) ----

export class SerialTextDriver implements ArmDriver {
  readonly kind = 'serial'
  readonly feedback = 'commanded'
  label = 'ob.Pal serial'
  onLost?: (why: string) => void
  private port: Port | null = null
  private line = ''
  private raw: (number | null)[] = Array(JOINT_COUNT).fill(null)
  private at = 0
  private banner = ''
  private timer: ReturnType<typeof setInterval> | undefined
  private lastSend = 0
  private enc = new TextEncoder()
  private dec = new TextDecoder()

  async connect() {
    this.port = await Port.ask(115200)
    this.port.onBytes = (b) => this.text(this.dec.decode(b, { stream: true }))
    this.port.onLost = (why) => { clearInterval(this.timer); this.onLost?.(why) }
    // Boards that reset when the port opens take a moment to start.
    for (let i = 0; i < 30 && !this.banner && !this.at; i++) {
      if (i % 5 === 0) await this.say('?')
      await sleep(100)
    }
    if (!this.banner && !this.at) { await this.close(); throw new Error('Nothing answered at 115200 baud. Is the ob.Pal arm sketch on the board?') }
    this.label = `${this.banner || 'ob.Pal serial'} · ${this.port.name}`
    this.timer = setInterval(() => void this.say('?'), 250)
  }

  private text(s: string) {
    this.line += s
    let n: number
    while ((n = this.line.indexOf('\n')) >= 0) {
      const l = this.line.slice(0, n).trim()
      this.line = this.line.slice(n + 1)
      if (l.startsWith('obpal-arm')) this.banner = l
      else if (l.startsWith('P ')) {
        const v = l.slice(2).trim().split(/\s+/).map(Number)
        if (v.length >= JOINT_COUNT && v.every(Number.isFinite)) { this.raw = v.slice(0, JOINT_COUNT); this.at = performance.now() }
      }
    }
    if (this.line.length > 256) this.line = ''
  }

  private say(s: string) { return this.port ? this.port.write(this.enc.encode(`${s}\n`)).catch(() => {}) : Promise.resolve() }

  read() { return this.at ? { raw: [...this.raw], at: this.at } : null }

  send(raw: number[]) {
    const now = performance.now()
    if (now - this.lastSend < 20) return
    this.lastSend = now
    void this.say(`J ${raw.map((v, i) => v.toFixed(i < 5 ? 1 : 2)).join(' ')}`)
  }

  async torque(on: boolean) { await this.say(on ? 'T1' : 'T0') }

  async close() {
    clearInterval(this.timer)
    const p = this.port
    this.port = null
    await p?.close()
  }
}

// ---- ROS 2 through rosbridge (the rosbridge v2 JSON protocol over a WebSocket) ----

export interface RosOptions {
  url: string
  /** Joint names in the sim's order: base, shoulder, elbow, wrist, roll, gripper. An empty name skips that joint. */
  joints: string[]
  /** trajectory: trajectory_msgs/JointTrajectory (a joint_trajectory_controller); array: std_msgs/Float64MultiArray (a position controller). */
  command: 'trajectory' | 'array'
  topic: string
  stateTopic: string
}

export const ROS_DEFAULTS: RosOptions = {
  url: 'ws://localhost:9090',
  joints: ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'],
  command: 'trajectory',
  topic: '/arm_controller/joint_trajectory',
  stateTopic: '/joint_states',
}

export class RosDriver implements ArmDriver {
  readonly kind = 'ros'
  readonly feedback = 'measured'
  label = 'ROS 2'
  onLost?: (why: string) => void
  private ws: WebSocket | null = null
  private raw: (number | null)[] = Array(JOINT_COUNT).fill(null)
  private at = 0
  private lastSend = 0
  private closing = false

  constructor(readonly o: RosOptions) {}

  async connect() {
    if (!/^wss?:\/\//.test(this.o.url)) throw new Error('A rosbridge address starts with ws:// or wss://')
    const ws = new WebSocket(this.o.url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`No rosbridge at ${this.o.url}`)), 5000)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = () => { clearTimeout(t); reject(new Error(location.protocol === 'https:' && this.o.url.startsWith('ws://') && !/\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(this.o.url) ? 'From this secure page, a rosbridge on another computer needs wss://' : `Couldn’t reach rosbridge at ${this.o.url}`)) }
    })
    ws.onclose = () => { if (!this.closing) this.onLost?.('rosbridge closed the connection') }
    ws.onmessage = (e) => this.message(e.data)
    const type = this.o.command === 'trajectory' ? 'trajectory_msgs/msg/JointTrajectory' : 'std_msgs/msg/Float64MultiArray'
    this.op({ op: 'advertise', id: 'obpal-cmd', topic: this.o.topic, type })
    this.op({ op: 'subscribe', id: 'obpal-state', topic: this.o.stateTopic, type: 'sensor_msgs/msg/JointState', throttle_rate: 50 })
    for (let i = 0; i < 30 && !this.at; i++) await sleep(100)
    this.label = `ROS 2 · ${this.o.topic}${this.at ? '' : ' · no joint states yet'}`
  }

  private op(m: object) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)) }

  private message(data: unknown) {
    if (typeof data !== 'string' || data.length > 200_000) return
    let m: { op?: string; topic?: string; msg?: { name?: unknown; position?: unknown } }
    try { m = JSON.parse(data) } catch { return }
    if (m.op !== 'publish' || m.topic !== this.o.stateTopic || !m.msg) return
    const names = m.msg.name
    const pos = m.msg.position
    if (!Array.isArray(names) || !Array.isArray(pos)) return
    let any = false
    this.o.joints.forEach((j, i) => {
      const k = j ? names.indexOf(j) : -1
      if (k >= 0 && typeof pos[k] === 'number' && Number.isFinite(pos[k])) { this.raw[i] = pos[k] as number; any = true }
    })
    if (any) this.at = performance.now()
  }

  read() { return this.at ? { raw: [...this.raw], at: this.at } : null }

  send(raw: number[]) {
    const now = performance.now()
    if (now - this.lastSend < 33) return
    this.lastSend = now
    const pick = this.o.joints.map((name, i) => ({ name, v: raw[i] })).filter((j) => j.name)
    if (this.o.command === 'trajectory') {
      this.op({ op: 'publish', topic: this.o.topic, msg: { joint_names: pick.map((j) => j.name), points: [{ positions: pick.map((j) => j.v), time_from_start: { sec: 0, nanosec: 100_000_000 } }] } })
    } else this.op({ op: 'publish', topic: this.o.topic, msg: { layout: { dim: [], data_offset: 0 }, data: pick.map((j) => j.v) } })
  }

  async torque() { /* ROS controllers hold their last command. */ }

  async close() {
    this.closing = true
    this.op({ op: 'unsubscribe', id: 'obpal-state', topic: this.o.stateTopic })
    this.op({ op: 'unadvertise', id: 'obpal-cmd', topic: this.o.topic })
    this.ws?.close()
    this.ws = null
  }
}
