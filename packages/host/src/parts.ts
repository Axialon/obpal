/**
 * What each participant's trackpad and tilt drive within the node it holds (PROTOCOL §3a): one of its parts, a set of
 * them, or the whole node (''), and the parts it has locked. The host checks both against what the node offers and
 * confirms them to that device in `state`. A device that never says drives the whole node, as before parts existed.
 */
import { LOCKS_VALUE, MAX_NODE_ID, MAX_PARTS, PART_VALUE, type SceneNode } from '@obpal/core'
import type { Participant } from './remote'

export interface Focus {
  /** The node it holds, or '' when it holds none. */
  node: string
  /** A part id, a set id, or '' (the whole node). */
  part: string
  /** The parts the trackpad and tilt drive, in the set's order; [] for the whole node. */
  parts: readonly string[]
  /** The parts that hold their pose: locked by the person, or outside a chosen set that locks the others. */
  locks: ReadonlySet<string>
  /** Bumped at every change, so a host starts what is newly chosen from where it is (a switch never jumps). */
  serial: number
}

/** A locks value as the ids it lists: comma-separated, trimmed, at most MAX_PARTS, none longer than a node id. */
export function readLocks(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return []
  return [...new Set(v.split(',').map((s) => s.trim()).filter((s) => s && s.length <= MAX_NODE_ID))].slice(0, MAX_PARTS)
}

/** What a choice means for a node: the parts it drives, and what holds (a pure reading, for hosts and tests). */
export function focusOf(node: SceneNode | undefined, part: string, locked: readonly string[]): { part: string; parts: string[]; locks: Set<string> } {
  const ids = (node?.parts ?? []).map((p) => p.id)
  const locks = new Set(locked.filter((id) => ids.includes(id)))
  const set = node?.sets?.find((s) => s.id === part)
  if (set) {
    const parts = set.parts.filter((id) => ids.includes(id))
    if (set.locks) for (const id of ids) if (!parts.includes(id)) locks.add(id)
    if (parts.length) return { part, parts, locks }
  }
  if (part && ids.includes(part)) return { part, parts: [part], locks }
  return { part: '', parts: [], locks }
}

interface Chosen { node: string; part: string; locks: string[]; serial: number }

/** The minimal Remote a PartFocus listens to and answers through. */
interface Wire {
  on(ev: 'value', fn: (e: { id: string; v: number | boolean | string }, who: Participant) => void): unknown
  on(ev: 'leave', fn: (p: Participant) => void): unknown
  setValues(values: Record<string, number | boolean | string>, who?: string): void
}

export class PartFocus {
  private chosen = new Map<string, Chosen>()
  private serial = 0

  /**
   * `held`: the node a participant holds now, with its parts and sets. `changed`: a participant's choice changed (a
   * sim redraws its highlight).
   */
  constructor(private remote: Wire, private held: (who: string) => SceneNode | undefined, private changed?: (who: string) => void) {
    remote.on('value', ({ id, v }, who) => {
      if (id === PART_VALUE && typeof v === 'string') this.choose(who.id, v.slice(0, MAX_NODE_ID))
      else if (id === LOCKS_VALUE && typeof v === 'string') this.lock(who.id, readLocks(v))
    })
    remote.on('leave', (p) => { this.chosen.delete(p.id) })
  }

  /** A participant's choice in the node it holds now: the whole node with nothing locked once it holds another. */
  of(who: string): Focus {
    const node = this.held(who)
    const c = this.chosen.get(who)
    const mine = c && node && c.node === node.id ? c : null
    const f = focusOf(node, mine?.part ?? '', mine?.locks ?? [])
    return { node: node?.id ?? '', part: f.part, parts: f.parts, locks: f.locks, serial: mine?.serial ?? 0 }
  }

  /** Choose what the trackpad drives (a part or set id; '' the whole node). Unknown ids choose the whole node. */
  choose(who: string, part: string) {
    const node = this.held(who)
    if (!node) return
    const c = this.current(who, node.id)
    const next = focusOf(node, part, c.locks).part
    if (next !== c.part) { c.part = next; c.serial = ++this.serial; this.changed?.(who) }
    this.confirm(who, c)
  }

  /** Lock these parts of the node held (the rest are free). */
  lock(who: string, ids: readonly string[]) {
    const node = this.held(who)
    if (!node) return
    const c = this.current(who, node.id)
    const next = [...focusOf(node, '', ids).locks]
    if (next.join() !== c.locks.join()) { c.locks = next; c.serial = ++this.serial; this.changed?.(who) }
    this.confirm(who, c)
  }

  /** Forget a participant's choice (it let go, or took another node), and tell its device: the whole node, unlocked. */
  reset(who: string) {
    const had = this.chosen.get(who)
    this.chosen.delete(who)
    if (had && (had.part || had.locks.length)) {
      this.changed?.(who)
      this.remote.setValues({ [PART_VALUE]: '', [LOCKS_VALUE]: '' }, who)
    }
  }

  private current(who: string, node: string): Chosen {
    let c = this.chosen.get(who)
    if (!c || c.node !== node) { c = { node, part: '', locks: [], serial: ++this.serial }; this.chosen.set(who, c) }
    return c
  }

  private confirm(who: string, c: Chosen) {
    this.remote.setValues({ [PART_VALUE]: c.part, [LOCKS_VALUE]: c.locks.join(',') }, who)
  }
}
