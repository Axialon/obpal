/**
 * Who holds which node in a shared scene (CATALOGUE §5): one participant per node, one node per participant. The host
 * owns the table and publishes it with Remote.setScene({ held: claims.snapshot() }).
 *
 * Nodes can nest (a robot arm and its joints): holding a node holds everything inside it, so nobody else can take a
 * node while its parent or one of its children is held by someone else.
 */
export class Claims {
  private byNode = new Map<string, string>()
  private byWho = new Map<string, string>()
  private parentOf = new Map<string, string>()

  /** Put `node` inside `parent`: whoever holds the parent controls the node too. */
  nest(node: string, parent: string) {
    for (let p: string | undefined = parent; p; p = this.parentOf.get(p)) if (p === node) throw new Error(`${node} can't be inside itself`)
    this.parentOf.set(node, parent)
  }

  /** Forget a node's nesting, both ways (it left the scene). */
  unnest(node: string) {
    this.parentOf.delete(node)
    for (const [child, p] of [...this.parentOf]) if (p === node) this.parentOf.delete(child)
  }

  /** The nodes that overlap `node`: those it is inside, then those inside it. */
  private related(node: string): string[] {
    const out: string[] = []
    for (let p = this.parentOf.get(node); p; p = this.parentOf.get(p)) out.push(p)
    const inside = (n: string) => { for (const [child, p] of this.parentOf) if (p === n) { out.push(child); inside(child) } }
    inside(node)
    return out
  }

  /**
   * Take `node` for `who`. Refused when someone else holds it or a node overlapping it, naming who (`holder`) and what
   * they hold (`blocking`), unless forced: the screen taking a node back. `released` is what `who` let go of to take
   * it; `lost` is who lost the node itself to a forced take, and `evicted` who lost an overlapping one.
   */
  take(node: string, who: string, force = false): { ok: boolean; holder?: string; blocking?: string; released?: string; lost?: string; evicted?: string[] } {
    const holder = this.byNode.get(node)
    const overlap = this.related(node).filter((n) => { const h = this.byNode.get(n); return h && h !== who })
    if (!force) {
      if (holder && holder !== who) return { ok: false, holder, blocking: node }
      if (overlap.length) return { ok: false, holder: this.byNode.get(overlap[0]), blocking: overlap[0] }
    }
    let lost: string | undefined
    if (holder && holder !== who) { this.byWho.delete(holder); lost = holder }
    const evicted: string[] = []
    for (const n of overlap) {
      const h = this.byNode.get(n)!
      this.byNode.delete(n)
      this.byWho.delete(h)
      evicted.push(h)
    }
    const before = this.byWho.get(who)
    const released = before && before !== node ? before : undefined
    if (released) this.byNode.delete(released)
    this.byNode.set(node, who)
    this.byWho.set(who, node)
    return evicted.length ? { ok: true, released, lost, evicted } : { ok: true, released, lost }
  }

  /** Let go of what `who` holds; returns that node. */
  release(who: string): string | undefined {
    const node = this.byWho.get(who)
    if (node) { this.byWho.delete(who); this.byNode.delete(node) }
    return node
  }

  /** Free a node (it left the scene); returns who held it. */
  free(node: string): string | undefined {
    const who = this.byNode.get(node)
    if (who) { this.byNode.delete(node); this.byWho.delete(who) }
    return who
  }

  holder(node: string): string | undefined { return this.byNode.get(node) }
  held(who: string): string | undefined { return this.byWho.get(who) }
  /** Who controls `node`: its holder, else whoever holds a node it is inside. */
  controller(node: string): string | undefined {
    for (let n: string | undefined = node; n; n = this.parentOf.get(n)) { const h = this.byNode.get(n); if (h) return h }
    return undefined
  }
  /** node id -> participant id, for Remote.setScene. Only the nodes actually held: devices read nesting from the nodes. */
  snapshot(): Record<string, string> { return Object.fromEntries(this.byNode) }
}
