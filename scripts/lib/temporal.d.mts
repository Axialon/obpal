export interface TemporalFrame {
  phase: string
  n: number
  samples: number
  p95: number
  spikes: number
}
export function temporalFailure(result: { frames: readonly TemporalFrame[] }): string | null
