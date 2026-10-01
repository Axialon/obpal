import { describe, expect, it } from 'vitest'
import { DESKTOP_GUIDE_CHANNEL, DESKTOP_GUIDE_URL, guideRequest, guideStatus, parseGuideStatus } from '../extension/src/shared/desktop-guide'
import { dotProgress, dotTimeline } from '../packages/host/src/dot-tokens'

describe('the Desktop companion status boundary', () => {
  const sender = { id: 'our-copy', url: DESKTOP_GUIDE_URL, frameId: 0, tab: { id: 7 } }
  const request = { to: 'bg', type: 'desktop-guide-status' }
  it('accepts only the own, top-level content script on the exact companion route', () => {
    expect(guideRequest(request, sender, 'our-copy')).toBe('desktop-guide-status')
    for (const bad of [{ id: 'other' }, { frameId: 1 }, { tab: {} }, { url: 'https://example.com/link/desktop/' }, { url: DESKTOP_GUIDE_URL + 'other' }, { url: 'chrome-extension://our-copy/options.html' }]) {
      expect(guideRequest(request, { ...sender, ...bad }, 'our-copy')).toBeNull()
    }
    expect(guideRequest({ to: 'bg', type: 'pc-config' }, sender, 'our-copy')).toBeNull()
  })
  it('forwards only status and a bounded version, never private fields', () => {
    const value = { link: 'ready' as const, version: '0.3.0', phone: 'private', error: 'private', config: { programs: ['private'] } }
    expect(guideStatus(value)).toEqual({ channel: DESKTOP_GUIDE_CHANNEL, status: 'ready', version: '0.3.0' })
    expect(guideStatus({ link: 'off', version: null }).status).toBe('off')
    expect(guideStatus({ link: 'error', version: 'untrusted text' })).not.toHaveProperty('version')
    expect(parseGuideStatus({ channel: DESKTOP_GUIDE_CHANNEL, status: 'ready', secret: 'private' })).toEqual({ channel: DESKTOP_GUIDE_CHANNEL, status: 'ready' })
    expect(parseGuideStatus({ channel: DESKTOP_GUIDE_CHANNEL, status: 'allowed' })).toBeNull()
  })
})

describe('the shared dot clock', () => {
  it('aligns devices by timestamp without changing the caller-owned handshake duration', () => {
    const timeline = dotTimeline(10000)
    expect(timeline.duration).toBe(1200)
    expect(dotProgress(timeline, 10000)).toBe(0)
    expect(dotProgress(timeline, 10600)).toBe(0.5)
    expect(dotProgress(timeline, 11200)).toBe(1)
    expect(dotProgress(timeline, 9000)).toBe(0)
    expect(dotProgress({ startedAt: 10000, duration: Infinity }, 11000)).toBe(1)
  })
})
