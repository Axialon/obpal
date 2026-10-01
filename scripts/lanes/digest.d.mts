import type { DecisionOptions } from '../lib/decision-model.mjs'
export interface Digest {
  status: string; head: string | null; master: string | null
  tests: { check: string; passed: number; total: number; skipped: number }[]
  failures: string[]; decisions: string[]; evidence: string[]; risks: string[]; verdict: string; reasons: string[]
}
export function extractDigest(source: { final: string; events?: string; err?: string; stopped?: boolean; incomplete?: boolean }): Digest
export function capDigest<T extends Digest>(value: T): T
export function summaryEvents(text: string): string
export function handbackInput(text: string, limit?: number): { text: string; truncated: boolean }
export function digestLane(local: string, name: string, options?: DecisionOptions): Promise<Digest & { model: string; tokens: { in: number | null; cached: number | null; out: number | null } | null; mode: string; note?: string }>
