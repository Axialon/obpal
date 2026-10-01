import { describe, expect, it } from 'vitest'
import { Remote } from '../packages/host/src/remote'

describe('the shared scene lead', () => {
  it('keeps the first bound phone when another prepared its offer earlier in the same millisecond', () => {
    const remote = Object.create(Remote.prototype)
    const first = { id: 'first', bound: true, since: 100, caps: { platform: 'android' } }
    const later = { id: 'later', bound: true, since: 100, caps: { platform: 'ios' } }
    Object.assign(remote, { active: first, peers: new Map([[later.id, later], [first.id, first]]) })
    expect(remote.leadPhone()).toBe(first)
  })

  it('stays with the first controller phone in 20 randomised mixed join orders', () => {
    let seed = 71
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
    for (let run = 0; run < 20; run++) {
      const order = ['scene', 'scene', 'scene', 'android', 'ios', 'android', 'scene', 'ios']
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
      const remote = Object.create(Remote.prototype)
      const peers = new Map()
      Object.assign(remote, { peers })
      let first: unknown = null
      order.forEach((platform, since) => {
        const peer = { id: String(since), bound: true, since, caps: { platform } }
        peers.set(peer.id, peer)
        if (platform !== 'scene' && !first) first = peer
        expect(remote.leadPhone()).toBe(first)
      })
      for (const [id, peer] of peers) if (peer.caps.platform !== 'scene') peers.delete(id)
      expect(remote.leadPhone()).toBeNull()
    }
  })
})
