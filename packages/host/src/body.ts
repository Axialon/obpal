import { BodyFlag, decodeBody, seqNewer, type BodyState } from '@obpal/core'

export interface BodyFrame extends Pick<BodyState, 't' | 'landmarks' | 'visibility' | 'presence'> {
  tracked: boolean
  /** Host generation, never reused by this input, including after reset. */
  gen: number
  /** Acceptance time on the host's monotonic clock; t stays on the capture clock. */
  receivedAt: number
}

export const BODY_STALE_MS = 250

/** The same validation and lifetime for a phone stream and an entirely local webcam. */
export class BodyInput {
  private state: BodyState | null = null
  private at = 0
  private generation = 0

  reset() { this.state = null; this.at = 0 }

  receive(packet: ArrayBuffer, now = performance.now()): boolean {
    const s = decodeBody(packet), old = this.state
    if (!s || (old && !seqNewer(s.seq, old.seq))) return false
    const acquired = !!(s.flags & BodyFlag.tracked) && (!old || !(old.flags & BodyFlag.tracked) || now - this.at >= BODY_STALE_MS)
    if (!old || s.gen !== old.gen || acquired) this.generation++
    // Keep the sequence after expiry: an old packet must never revive an expired body.
    this.state = s; this.at = now
    return true
  }

  read(now = performance.now()): BodyFrame | null {
    const s = this.state
    return s && now - this.at < BODY_STALE_MS ? {
      tracked: !!(s.flags & BodyFlag.tracked), gen: this.generation, t: s.t, receivedAt: this.at,
      landmarks: s.landmarks, visibility: s.visibility, presence: s.presence,
    } : null
  }
}
