/**
 * Who holds which node in a shared scene (CATALOGUE §5): one participant per node, one node per participant. The host
 * owns the table and publishes it with Remote.setScene({ held: claims.snapshot() }).
 */
export class Claims {
  private byNode = new Map<string, string>()
  private byWho = new Map<string, string>()

  /**
   * Take `node` for `who`. Refused (with who holds it) when someone else has it, unless forced: the screen taking a
   * node back. `released` is what `who` let go of to take it; `lost` is who lost the node to a forced take.
   */
  take(node: string, who: string, force = false): { ok: boolean; holder?: string; released?: string; lost?: string } {
    const holder = this.byNode.get(node)
    if (holder && holder !== who && !force) return { ok: false, holder }
    let lost: string | undefined
    if (holder && holder !== who) { this.byWho.delete(holder); lost = holder }
    const before = this.byWho.get(who)
    const released = before && before !== node ? before : undefined
    if (released) this.byNode.delete(released)
    this.byNode.set(node, who)
    this.byWho.set(who, node)
    return { ok: true, released, lost }
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
  /** node id -> participant id, for Remote.setScene. */
  snapshot(): Record<string, string> { return Object.fromEntries(this.byNode) }
}
