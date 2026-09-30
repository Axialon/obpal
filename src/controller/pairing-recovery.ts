import type { LinkStatus } from '@obpal/core'

/** Recovery copy describes an ongoing attempt, not a transport diagnosis or a new timeout. */
export const STILL_CONNECTING = "Still connecting. Keep the screen's ob.Pal page open. You can cancel this attempt or enter its current code."
export const pendingPhase = (status: LinkStatus) => ['signaling', 'waiting-host', 'connecting', 'securing', 'reconnecting', 'unreachable', 'connected'].includes(status)
