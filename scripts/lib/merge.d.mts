/** See merge.mjs. */
export const PUBLIC_EMAIL: string
export const DEFAULT_CO_AUTHOR: string
export function parseArgs(argv: string[]): { branch: string; message: string; dryRun: boolean; allow: string[]; help: boolean }
export function summarizeNumstat(numstat: string, top?: number): {
  files: number
  added: number
  deleted: number
  biggest: { path: string; added: number; deleted: number; binary: boolean }[]
}
export function parseVitest(output: string): { passed: number; failed: number; skipped: number; total: number; files: number } | null
export function pickCoAuthor(messages: string[], fallback?: string): string
export function applyAllow<F extends { path: string; line?: number }>(findings: F[], allow: string[]): { standing: F[]; allowed: F[] }
