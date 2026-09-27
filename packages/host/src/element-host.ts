/**
 * What <obpal-remote> loads when it starts (./element.ts): the Remote, the pairing chip, the claims of a shared scene,
 * and the Remote's events as the element's DOM events. Kept apart so a page carries only the small element until a
 * person is there.
 */
import type { Layout, SceneNode } from '@obpal/core'
import { Claims } from './claims'
import { createChip, type Chip, type ChipOptions } from './element-chip'
import { Remote, type Frame, type HostStatus, type Participant } from './remote'

export { embedLayout, parseCorner, parseFlag, parseScheme, parseSeats } from './embed-attrs'
export { Remote }

/** How the element starts its host. */
export interface HostStart {
  appName: string
  /** The room service; the Remote's own default when absent. */
  service?: string
  seats: number
  layout: Layout
  chip: Omit<ChipOptions, 'remote' | 'onToggle'>
  /** Fire `obpal-<name>` on the element; false when a listener cancelled it. */
  emit: (name: string, detail: object, cancelable?: boolean) => boolean
  status: (s: HostStatus) => void
  /** The chip opened or closed. */
  toggled: (open: boolean) => void
}

/** The started element's host: the Remote, and what the element passes through to it. */
export interface ElementHost {
  readonly remote: Remote
  readonly expanded: boolean
  frame(now: number, who?: string): Frame
  setScene(s: { nodes?: SceneNode[]; held?: Record<string, string> }): void
  holder(node: string): string | null
  holding(who: string): string | null
  held(): Record<string, string>
  setLayout(layout: Layout): void
  setChip(chip: Omit<ChipOptions, 'remote' | 'onToggle'>): void
  expand(open: boolean): void
  destroy(): void
}

/** Why this browser can't host a phone, or null when it can. */
export function cannotHost(): string | null {
  if (typeof RTCPeerConnection !== 'function' || typeof RTCPeerConnection.generateCertificate !== 'function') return 'this browser has no WebRTC (or it is turned off)'
  if (typeof WebSocket !== 'function') return 'this browser has no WebSocket'
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) return 'the page is not a secure context (https or localhost)'
  return null
}

/**
 * Start the host: null (with why in `unsupported`) where this browser can't. In a shared scene (seats > 1) the element
 * keeps the claims itself, one participant per node and first come, unless a listener cancels `obpal-claim`.
 */
export async function startHost(o: HostStart): Promise<{ host: ElementHost } | { unsupported: string }> {
  const why = cannotHost()
  if (why) return { unsupported: why }
  const remote = await Remote.create({ appName: o.appName, service: o.service, layout: o.layout, seats: o.seats })
  const claims = new Claims()
  const people = new Map<string, Participant>()
  /** Each participant's last (mode, controller, profile), so `obpal-mode` fires once per change. */
  const modes = new Map<string, string>()
  let nodes: SceneNode[] = []

  const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name ?? id
  const nameOf = (id: string | undefined) => (id === 'host' ? 'The screen' : (id && people.get(id)?.name) || 'Someone')
  const publish = (withNodes = false) => remote.setScene({ held: claims.snapshot(), ...(withNodes ? { nodes } : {}) })
  /** What a phone shows as held (its part chip). */
  const tell = (who: string) => {
    if (who === 'host' || !people.has(who)) return
    const node = claims.held(who)
    remote.setValues(node ? { part: nodeName(node), partLive: false, partValue: '' } : { part: '' }, who)
  }
  const take = (node: string, who: string) => {
    if (!nodes.some((n) => n.id === node)) { remote.feedback({ haptic: 'bump', toast: 'That’s not in this scene' }, who); return }
    const r = claims.take(node, who)
    if (!r.ok) { remote.feedback({ haptic: 'bump', toast: `${nameOf(r.holder)} has ${nodeName(r.blocking ?? node)}` }, who); return }
    remote.feedback({ haptic: 'tick', toast: `You have ${nodeName(node)}` }, who)
    tell(who)
    publish()
  }
  const release = (who: string) => {
    if (!claims.release(who)) return
    tell(who)
    publish()
  }

  remote.on('status', (s) => o.status(s))
  remote.on('connect', (info) => o.emit('connect', info))
  remote.on('disconnect', () => o.emit('disconnect', {}))
  remote.on('join', (p) => { people.set(p.id, p); o.emit('join', { participant: p }) })
  remote.on('leave', (p) => {
    people.delete(p.id)
    modes.delete(p.id)
    if (claims.release(p.id)) publish()
    o.emit('leave', { participant: p })
  })
  remote.on('button', (e, who) => {
    // The × on a phone's held-part chip lets go of what it holds.
    if (e.id === 'part-release' && claims.held(who.id)) release(who.id)
    o.emit('button', { id: e.id, ev: e.ev, participant: who })
  })
  remote.on('text', (e, who) => o.emit('text', { s: e.s, del: e.del, participant: who }))
  remote.on('toss', (e, who) => o.emit('toss', { v: e.v, participant: who }))
  remote.on('value', (e, who) => o.emit('value', { id: e.id, v: e.v, add: e.add, participant: who }))
  remote.on('recenter', (who) => o.emit('recenter', { participant: who }))
  remote.on('pad', (connected, who) => o.emit('pad', { connected, participant: who }))
  remote.on('mode', (m, who) => {
    // A phone's mode arrives in its packets and in its mode message: once per change is enough.
    const key = `${m} ${who.controller ?? ''} ${who.profile ?? ''}`
    if (modes.get(who.id) === key) return
    modes.set(who.id, key)
    o.emit('mode', { mode: m, controller: who.controller, profile: who.profile, participant: who })
  })
  remote.on('claim', ({ node }, who) => {
    if (!o.emit('claim', { node, participant: who }, true)) return
    if (node === null) release(who.id)
    else take(node, who.id)
  })

  let chip: Chip = createChip({ remote, ...o.chip, onToggle: o.toggled })

  const host: ElementHost = {
    remote,
    get expanded() { return chip.expanded },
    frame: (now, who) => (who ? remote.consumeOf(who, now) : remote.consume(now)),
    setScene(s) {
      if (s.nodes) {
        const next = s.nodes.map((n) => ({ ...n }))
        // Whoever held a node that left the scene lets go of it.
        for (const n of nodes) {
          if (next.some((x) => x.id === n.id)) continue
          const who = claims.free(n.id)
          claims.unnest(n.id)
          if (who && who !== 'host') { remote.feedback({ haptic: 'bump', toast: `${n.name} left the scene` }, who); remote.setValues({ part: '' }, who) }
        }
        nodes = next
        for (const n of nodes) if (n.parent) try { claims.nest(n.id, n.parent) } catch { /* a node inside itself: flat */ }
      }
      if (s.held) {
        // The page says who holds what: the table becomes exactly that, and each phone hears what it now holds.
        const before = new Map([...people.keys()].map((id) => [id, claims.held(id)]))
        for (const node of Object.keys(claims.snapshot())) claims.free(node)
        for (const [node, who] of Object.entries(s.held)) claims.take(node, who, true)
        for (const [id, was] of before) if (claims.held(id) !== was) tell(id)
      }
      publish(!!s.nodes)
    },
    holder: (node) => claims.controller(node) ?? null,
    holding: (who) => claims.held(who) ?? null,
    held: () => claims.snapshot(),
    setLayout: (layout) => remote.setLayout(layout),
    setChip(opts) {
      const open = chip.expanded
      chip.destroy()
      chip = createChip({ remote, ...opts, open, onToggle: o.toggled })
    },
    expand(open) { if (open !== chip.expanded) { if (open) chip.expand(); else chip.collapse() } },
    destroy() {
      chip.destroy()
      remote.destroy()
    },
  }
  return { host }
}
