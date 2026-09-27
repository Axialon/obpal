/** Music shares ctl with buttons; clock replies use state, so older screens safely ignore it. */
import type { DeviceMsg } from '@obpal/core'
import type { MusicEvent } from '../music'

export class MusicWire {
  private seq = 0
  private offset = 0
  private rtt = Infinity
  private active = false
  private syncAt = 0
  constructor(private send: (m: DeviceMsg) => void) {
    setInterval(() => {
      if (!this.active || document.hidden) return
      this.event('alive')
      if (performance.now() - this.syncAt > 2000) this.sync()
    }, 250)
  }
  sync() {
    this.syncAt = performance.now()
    this.send({ t: 'value', id: 'music.sync', v: performance.timeOrigin + this.syncAt })
  }
  reply(value: unknown) {
    if (typeof value !== 'string') return
    try {
      const { at, host } = JSON.parse(value)
      const now = performance.timeOrigin + performance.now()
      const rtt = now - at
      if (Number.isFinite(host) && rtt >= 0 && rtt < this.rtt) { this.rtt = rtt; this.offset = host - (at + now) / 2 }
    } catch { /* Unknown state is ignored, like the other optional controls. */ }
  }
  use(on: boolean) { this.active = on; if (on) this.sync(); else this.event('stop') }
  event(op: MusicEvent['op'], n = 0, v = 0, x = 0, time = performance.now()) {
    const e: MusicEvent = { op, seq: this.seq++, at: Number.isFinite(this.rtt) ? performance.timeOrigin + time + this.offset : 0, uncertainty: Number.isFinite(this.rtt) ? this.rtt / 2 : 0, n, v, x }
    this.send({ t: 'value', id: 'music.event', v: JSON.stringify(e) })
  }
}
