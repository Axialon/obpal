/** A held button has one owner per finger or hardware source. Only the first press and last release reach the wire. */
export class PressOwners {
  private owners = new Set<number | string>()
  constructor(private readonly change: (down: boolean) => void) {}
  set(owner: number | string, down: boolean) {
    const before = this.owners.size > 0
    if (down) this.owners.add(owner)
    else this.owners.delete(owner)
    const after = this.owners.size > 0
    if (before !== after) this.change(after)
  }
  reset() {
    if (!this.owners.size) return
    this.owners.clear()
    this.change(false)
  }
}

/** Capture the finger through a slide off the button; cancellation never synthesises a click. */
export function bindPress(el: HTMLElement, owners: PressOwners) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault()
    try { el.setPointerCapture(e.pointerId) } catch { /* not a live pointer */ }
    owners.set(e.pointerId, true)
  })
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    el.addEventListener(type, e => owners.set(e.pointerId, false))
  }
  el.addEventListener('contextmenu', e => e.preventDefault())
}
