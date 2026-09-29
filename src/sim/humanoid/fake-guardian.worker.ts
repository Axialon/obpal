/** Separate scheduling domain for browser-freeze tests. No socket, DDS or device API exists here. */
import { FakeGuardian, type FakeFaults } from './fake-guardian'
import type { DriverKind } from './driver-profile'
import { TIMING } from './drivers'

const scope = globalThis as unknown as {
  postMessage(message: unknown): void
  onmessage: (event: MessageEvent) => void
  close(): void
}
let guardian: FakeGuardian | null = null
let timer: ReturnType<typeof setInterval> | undefined
scope.onmessage = (event) => {
  const message = event.data as {
    type: string
    kind?: DriverKind
    data?: string
    id?: number
    faults?: FakeFaults
    pose?: Record<string, number>
  }
  if (message.type === 'init' && !guardian) {
    guardian = new FakeGuardian(
      message.kind!,
      () => performance.now(),
      (data) => scope.postMessage({ type: 'wire', data }),
    )
    timer = setInterval(() => guardian!.tick(), TIMING.guardian)
    scope.postMessage({ type: 'ready' })
  } else if (guardian) {
    if (message.type === 'wire') guardian.receive(message.data!)
    else if (message.type === 'faults') {
      guardian.faults = message.faults ?? {}
      if (message.pose) Object.assign(guardian.pose, message.pose)
      guardian.tick()
      if (message.faults?.socketLost) scope.postMessage({ type: 'lost', reason: 'Simulated rosbridge connection lost' })
    } else if (message.type === 'close') {
      guardian.close()
      clearInterval(timer)
      scope.close()
    }
    if (message.id !== undefined) scope.postMessage({ type: 'snapshot', id: message.id, value: guardian.snapshot() })
  }
}
