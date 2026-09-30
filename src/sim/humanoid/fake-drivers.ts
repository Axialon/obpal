/** The only transports selectable in the shipped UI are Worker-backed simulations. */
import { fakeProfile, type DriverKind } from './driver-profile'
import { RosbridgeDriver, type BridgeTransport } from './drivers'
import type { FakeFaults, FakeGuardian, GuardianTrace } from './fake-guardian'
import { cameraWorker } from '../../ui/camera-worker'

type Snapshot = ReturnType<FakeGuardian['snapshot']> & {
  timeOrigin: number
  timeline: GuardianTrace[]
  pageTimeOrigin: number
  pageTimeline: GuardianTrace[]
}
export class FakeRosbridge implements BridgeTransport {
  onMessage = (_message: string) => {}
  onLost = (_reason: string) => {}
  private worker: Worker | null = null
  private lost = false
  private sequence = 0
  private tracing = false
  private timeline: GuardianTrace[] = []
  private pending = new Map<
    number,
    { resolve: (value: Snapshot) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  constructor(readonly kind: DriverKind) {}
  async open() {
    this.lost = false
    const worker = cameraWorker('guardian')
    this.worker = worker
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate()
        reject(new Error('Simulated guardian did not start'))
      }, 5000)
      worker.onerror = () => {
        clearTimeout(timer)
        reject(new Error('Simulated guardian failed'))
        this.onLost('Simulated guardian failed')
      }
      worker.onmessage = (event) => {
        const message = event.data
        if (message.type === 'ready') {
          clearTimeout(timer)
          resolve()
        } else if (message.type === 'wire' && !this.lost) {
          this.record('receive', message.data)
          this.onMessage(message.data)
        }
        else if (message.type === 'lost') {
          this.lost = true
          this.onLost(message.reason)
        } else if (message.type === 'snapshot') {
          const request = this.pending.get(message.id)
          if (request) {
            clearTimeout(request.timer)
            this.pending.delete(message.id)
            request.resolve({ ...message.value, pageTimeOrigin: performance.timeOrigin, pageTimeline: [...this.timeline] })
          }
        }
      }
      worker.postMessage({ type: 'init', kind: this.kind })
    })
  }
  send(data: string) {
    if (!this.worker || this.lost) throw new Error('Simulated rosbridge is disconnected')
    this.record('send', data)
    this.worker.postMessage({ type: 'wire', data })
  }
  private record(action: string, data: string) {
    if (!this.tracing) return
    // Diagnostic parsing must never intercept malformed traffic's hold path.
    try {
      const message = JSON.parse(data),
        value = message.msg ?? message.args ?? message.values ?? {}
      this.timeline.push({
        action: `${action}:${message.topic ?? message.service}`,
        at: performance.now(),
        kind: value.kind ?? value.mode,
        seq: value.seq,
        reportedAt: value.at,
        reason: value.reason ?? value.fault,
      })
    } catch {
      this.timeline.push({ action: `${action}:malformed`, at: performance.now() })
    }
    if (this.timeline.length > 2000) this.timeline.shift()
  }
  /** Enabled only by the local test harness; no trace is persisted or transmitted. */
  trace() {
    this.tracing = true
    this.timeline = []
    return this.request('trace')
  }
  private request(type: string, extra = {}) {
    const id = ++this.sequence
    return new Promise<Snapshot>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('No simulated guardian'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Simulation inspection timed out'))
      }, 1500)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ type, id, ...extra })
    })
  }
  /** Fault injection is exposed to the browser harness only through its loopback test seam. */
  faults(faults: FakeFaults, pose?: Record<string, number>) {
    return this.request('faults', { faults, pose })
  }
  snapshot() {
    return this.request('snapshot')
  }
  close() {
    const worker = this.worker
    this.worker = null
    worker?.postMessage({ type: 'close' })
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Simulation closed'))
    }
    this.pending.clear()
    // The close message performs the simulated driver's hold before the Worker exits.
    if (worker) setTimeout(() => worker.terminate(), 100)
  }
}
export function simulatedDriver(kind: DriverKind) {
  const transport = new FakeRosbridge(kind)
  return { driver: new RosbridgeDriver(fakeProfile(kind), transport), transport }
}
