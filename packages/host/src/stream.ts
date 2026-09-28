import {
  accumDelta, decodePad, decodePointer, decodePose, decodeState, emptyPad, Flag, Mode, PadFlag, PointerFlag, PoseFlag, qIdentity, qSlerp, seqNewer, Tier,
  type ModeId, type PadState, type PointerState, type Quat, type TierId, type Vec3, type WireState,
} from '@obpal/core'

/** Everything a host needs per rendered frame. Deltas are since the previous consume() call. */
export interface Frame {
  connected: boolean
  mode: ModeId
  tier: TierId
  /** True while the user holds the grab control; qRel is then the phone's rotation since grabbing. */
  clutch: boolean
  grab: number
  qRel: Quat
  touching: boolean
  aim: [number, number]
  /** Racing-style tilt stick in [-1, 1]: [steer (+ = right), pitch (+ = top toward the user)]. A position, not a delta. */
  tilt: [number, number]
  pad1: [number, number]
  pad2: [number, number]
  zoom: number
  twist: number
  /**
   * Where the device is in space while it tracks itself (mode 6, POSE packets), else null. `tracked` is false while
   * it has lost track of the world; `touching` is the deadman, sampled with the pose; a new `gen` is a new origin.
   */
  pose: { p: Vec3; q: Quat; tracked: boolean; touching: boolean; gen: number } | null
}

/** A pointer stream that stops (the utility was switched off, the phone went away) is gone after this long. */
const POINTER_STALE_MS = 300
/** A silent pad releases its controls before its connection expires. */
const PAD_STALE_MS = 300
/** A pose stream that stops is gone after this long. */
const POSE_STALE_MS = 250

/** Continuous (unwrapped) accumulator totals, so the host can interpolate them in time. */
interface Acc { aim: [number, number]; pad1: [number, number]; pad2: [number, number]; zoom: number; twist: number }
const zeroAcc = (): Acc => ({ aim: [0, 0], pad1: [0, 0], pad2: [0, 0], zoom: 0, twist: 0 })
function combineAcc(a: Acc, b: Acc, k: number): Acc {
  return {
    aim: [a.aim[0] + b.aim[0] * k, a.aim[1] + b.aim[1] * k],
    pad1: [a.pad1[0] + b.pad1[0] * k, a.pad1[1] + b.pad1[1] * k],
    pad2: [a.pad2[0] + b.pad2[0] * k, a.pad2[1] + b.pad2[1] * k],
    zoom: a.zoom + b.zoom * k,
    twist: a.twist + b.twist * k,
  }
}
const lerpAcc = (a: Acc, b: Acc, t: number) => combineAcc(a, combineAcc(b, a, -1), t)

export interface StreamHooks {
  /** The device switched mode (from its STATE packets). */
  mode: (m: ModeId) => void
  /** The device entered (true) or left (false) gamepad mode. */
  pad: (connected: boolean) => void
  /** A packet just arrived (sample now for the lowest latency). */
  input: () => void
}

/** One device's input: its STATE, PAD and POINTER packets, buffered and interpolated for the host's frames. */
export class Stream {
  private latest: WireState | null = null
  private padState: PadState | null = null
  private padAt = 0
  private ptr: PointerState | null = null
  private ptrAt = 0
  private pose: ReturnType<typeof decodePose> = null
  private poseAt = 0
  private stateAt = 0
  private latestAcc: Acc | null = null
  private outAcc: Acc | null = null
  private outMode: ModeId | null = null
  private lastConsumeAt = 0
  private buf: { t: number; s: WireState; acc: Acc }[] = []
  private offsets: [number, number][] = []
  private tBase = 0
  private tLast = -1
  private lastMode: ModeId | null = null

  constructor(private hooks: StreamHooks, private latency: 'smooth' | 'direct' = 'smooth') {}

  reset() {
    this.padState = null
    this.padAt = 0
    this.ptr = null
    this.ptrAt = 0
    this.pose = null
    this.poseAt = 0
    this.stateAt = 0
    this.latest = null
    this.latestAcc = null
    this.outAcc = null
    this.outMode = null
    this.buf = []
    this.offsets = []
    this.tBase = 0
    this.tLast = -1
    this.lastMode = null
  }

  private unwrapMs(t: number): number {
    if (this.tLast >= 0 && t < this.tLast && this.tLast - t > 0x80000000) this.tBase += 0x100000000
    this.tLast = t
    return (this.tBase + t) / 1000
  }

  onState(data: ArrayBuffer) {
    const s = decodeState(data)
    if (!s || (this.latest && !seqNewer(s.seq, this.latest.seq))) return
    const now = performance.now()
    const dev = this.unwrapMs(s.t)
    this.offsets.push([now, now - dev])
    while (this.offsets.length && now - this.offsets[0][0] > 2000) this.offsets.shift()
    const offset = Math.min(...this.offsets.map((o) => o[1]))
    const acc = this.latest && this.latestAcc ? combineAcc(this.latestAcc, accumDelta(s, this.latest), 1) : zeroAcc()
    this.buf.push({ t: dev + offset, s, acc })
    if (this.buf.length > 40) this.buf.shift()
    this.latest = s
    this.latestAcc = acc
    this.stateAt = now
    if (s.mode !== this.lastMode) { this.lastMode = s.mode; this.hooks.mode(s.mode) }
    this.hooks.input()
  }

  onPad(data: ArrayBuffer) {
    const p = decodePad(data)
    if (!p || (this.padState && !seqNewer(p.seq, this.padState.seq))) return
    const was = this.padLive
    this.padState = p
    this.padAt = performance.now()
    if (!was) this.hooks.pad(true)
    this.hooks.input()
  }

  onPointer(data: ArrayBuffer) {
    const p = decodePointer(data)
    if (!p || !(p.flags & PointerFlag.valid) || (this.ptr && !seqNewer(p.seq, this.ptr.seq))) return
    this.ptr = p
    this.ptrAt = performance.now()
    this.hooks.input()
  }

  onPose(data: ArrayBuffer) {
    const p = decodePose(data)
    if (!p || (this.pose && p.gen === this.pose.gen && !seqNewer(p.seq, this.pose.seq))) return
    this.pose = p
    this.poseAt = performance.now()
    this.hooks.input()
  }

  private get padLive() { return !!this.padState && performance.now() - this.padAt < 1500 }

  /** Latest controller state, neutral after a short silence, null once the pad expires. */
  get pad(): PadState | null {
    if (this.padState && !this.padLive) { this.padState = null; this.hooks.pad(false) }
    if (this.padState && performance.now() - this.padAt >= PAD_STALE_MS) return { ...emptyPad(), seq: this.padState.seq, t: this.padState.t }
    return this.padState
  }

  /**
   * Where the device points (PROTOCOL §6) while a pointing utility is on, else null. Absolute pointers (the Wii-style
   * cursor) end the moment the pad says Point is off; any pointer ends after a short silence.
   */
  get pointer(): PointerState | null {
    const p = this.ptr
    if (!p) return null
    const pad = this.padState
    const off = pad && this.padLive && !(p.flags & PointerFlag.relative) && !(pad.flags & PadFlag.point) && this.padAt >= this.ptrAt
    if (off || performance.now() - this.ptrAt > POINTER_STALE_MS) { this.ptr = null; return null }
    return p
  }

  /** Read input for this frame. Call once per rendered frame (e.g. inside requestAnimationFrame). */
  consume(now: number, connected: boolean): Frame {
    const s = this.latest
    const frame: Frame = {
      connected, mode: s?.mode ?? Mode.hold, tier: s?.tier ?? Tier.touch,
      clutch: false, grab: s?.grab ?? 0, qRel: qIdentity(), touching: false,
      aim: [0, 0], tilt: [0, 0], pad1: [0, 0], pad2: [0, 0], zoom: 0, twist: 0,
      pose: this.pose && now - this.poseAt < POSE_STALE_MS ? { p: this.pose.p, q: this.pose.q, tracked: (this.pose.flags & PoseFlag.tracked) !== 0, touching: (this.pose.flags & PoseFlag.touching) !== 0, gen: this.pose.gen } : null,
    }
    // Gamepad mode: PAD packets replace STATE, so the last STATE (a held tilt, a gyro grab) must not keep driving
    // the view even if every hand-off STATE was lost on the unreliable channel. A first PAD also stands alone,
    // including after attention resumes and the previous stream was cleared.
    if (this.padLive && this.padAt > this.stateAt) { frame.mode = Mode.gamepad; return frame }
    if (!s || !this.buf.length) return frame

    // Sample everything one sensor period behind and interpolate, so motion is even from frame to frame
    // regardless of network jitter. 'direct' uses the newest packet instead.
    let ai = this.buf.length - 1
    let bi = -1
    let alpha = 0
    if (this.latency !== 'direct') {
      const target = now - 1000 / 60
      ai = 0
      for (let i = this.buf.length - 1; i >= 0; i--) {
        if (this.buf[i].t <= target) {
          ai = i
          if (i + 1 < this.buf.length) {
            bi = i + 1
            alpha = Math.min(1, Math.max(0, (target - this.buf[i].t) / Math.max(1, this.buf[bi].t - this.buf[i].t)))
          }
          break
        }
      }
    }
    const A = this.buf[ai]
    const B = bi >= 0 ? this.buf[bi] : null
    const accNow = B ? lerpAcc(A.acc, B.acc, alpha) : A.acc
    // After a stall (hidden tab, long frame) drop the backlog instead of applying it as one jump. Point mode is the
    // exception: its aim is where the phone points (absolute), so the cursor catches up rather than falling out of step.
    const fresh = !!this.outAcc && now - this.lastConsumeAt < 250
    const d = fresh ? combineAcc(accNow, this.outAcc!, -1) : zeroAcc()
    if (!fresh && this.outAcc && this.outMode === Mode.point && A.s.mode === Mode.point) {
      d.aim = [accNow.aim[0] - this.outAcc.aim[0], accNow.aim[1] - this.outAcc.aim[1]]
    }
    this.outAcc = accNow
    this.outMode = A.s.mode
    this.lastConsumeAt = now
    frame.aim = d.aim
    frame.pad1 = d.pad1
    frame.pad2 = d.pad2
    frame.zoom = d.zoom
    frame.twist = d.twist
    frame.touching = (s.flags & Flag.touching) !== 0

    const a = A.s
    const b = B?.s
    frame.mode = a.mode
    frame.tilt = b ? [a.tilt[0] + (b.tilt[0] - a.tilt[0]) * alpha, a.tilt[1] + (b.tilt[1] - a.tilt[1]) * alpha] : a.tilt
    frame.clutch = (a.flags & Flag.clutch) !== 0
    frame.grab = a.grab
    frame.qRel = a.qRel
    if (b && frame.clutch && (b.flags & Flag.clutch) && b.grab === a.grab) frame.qRel = qSlerp(a.qRel, b.qRel, Math.min(1, Math.max(0, alpha)))
    // No STATE for 250 ms (phone backgrounded, network stall): ease rate controls to rest over 150 ms instead of
    // leaving a tilt latched. The phone sends at least 15 Hz while connected, so this only trips on a real gap.
    const silent = now - this.stateAt
    if (silent > 250) {
      const k = Math.max(0, 1 - (silent - 250) / 150)
      frame.tilt = [frame.tilt[0] * k, frame.tilt[1] * k]
      frame.touching = false
    }
    return frame
  }
}
