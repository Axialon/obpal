/** One Euro filter (Casiez et al.): low jitter at rest, low lag when moving fast. */
export class OneEuro {
  private x: number | null = null
  private dx = 0
  constructor(public minCutoff = 1, public beta = 0.01, public dCutoff = 1) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  filter(value: number, dt: number): number {
    if (this.x === null || dt <= 0) { this.x = value; return value }
    const d = (value - this.x) / dt
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (d - this.dx)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx)
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x)
    return this.x
  }

  reset() { this.x = null; this.dx = 0 }
}
