export interface WarmupFrame { t: number; mean: number; delta: number; black: number; alternation: number; alternation2?: number; alternation3?: number; area?: number }
export interface WarmupResult {
  frames: WarmupFrame[]
  screens?: WarmupFrame[]
  events: { t: number; kind: string }[]
  reveal: number | null
  end: number
  error: string | null
}
export function flickerEvents(result: WarmupResult): { t: number; kind: string; source: string; index: number; mean: number; area: number }[]
export function warmupFailure(result: WarmupResult): string | null
