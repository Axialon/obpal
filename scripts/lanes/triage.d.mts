import type { DecisionOptions } from '../lib/decision-model.mjs'
export const KNOWN_FLAKY: string[]
export interface Failure { file: string; line: string; category: string; cause: string; rerun: string }
export function rerunCommand(file: string, line: string): string
export function failureCategory(line: string, context?: string): string
export function extractTriage(logs: { file: string; text: string; truncated?: boolean }[]): { failures: Failure[] }
export function triageDirectory(directory: string, options?: DecisionOptions): Promise<{ failures: Failure[]; model: string; tokens: { in: number | null; cached: number | null; out: number | null } | null; mode: string; note?: string; advisory: string }>
