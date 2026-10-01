import { SERVICE } from './constants'
import type { PcState } from './native'

export const DESKTOP_GUIDE_CHANNEL = 'obpal-link/desktop-guide/v1'
export const DESKTOP_GUIDE_URL = `${SERVICE}/link/desktop/`
export const LINK_TRY_URL = `${SERVICE}/link/try/`
export type GuideRequest = 'desktop-guide-status' | 'desktop-guide-open'
export interface GuideStatus { channel: typeof DESKTOP_GUIDE_CHANNEL; status: PcState['link']; version?: string }

/** Only our own isolated content script in the exact, top-level companion route may use this read-only bridge. */
export function guideRequest(raw: unknown, sender: { id?: string; url?: string; frameId?: number; tab?: { id?: number } }, self: string): GuideRequest | null {
  if (!raw || typeof raw !== 'object' || sender.id !== self || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return null
  try {
    const url = new URL(sender.url ?? '')
    if (url.origin !== SERVICE || url.pathname !== '/link/desktop/') return null
  } catch { return null }
  const msg = raw as Record<string, unknown>
  return msg.to === 'bg' && (msg.type === 'desktop-guide-status' || msg.type === 'desktop-guide-open') ? msg.type : null
}

/** No phone identities, paths, permissions, input, credentials or native error strings cross into the page. */
export function guideStatus(pc: Pick<PcState, 'link' | 'version'>): GuideStatus {
  return { channel: DESKTOP_GUIDE_CHANNEL, status: pc.link, ...(typeof pc.version === 'string' && /^[0-9]+(?:\.[0-9]+){1,3}$/.test(pc.version) ? { version: pc.version } : {}) }
}
export function parseGuideStatus(raw: unknown): GuideStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as GuideStatus
  if (value.channel !== DESKTOP_GUIDE_CHANNEL || !['off', 'permission', 'connecting', 'missing', 'error', 'ready'].includes(value.status)) return null
  return guideStatus({ link: value.status, version: value.version ?? null })
}
