/** See e2e.mjs. */
export const ORDER: string[]
export const DEFAULT_PORT: number
export const DEFAULT_WORKER_PORT: number
export function knownSuites(scripts: Record<string, string> | undefined): string[]
export function parseArgs(argv: string[], known: string[]): { suites: string[]; out: string; waitMin: number; timeoutMin: number | null; help: boolean }
export function suiteTimeout(suite: string, opts: { timeoutMin: number | null }, env?: Record<string, string | undefined>): number
export function suitePorts(suite: string, env?: Record<string, string | undefined>): { port: number | null; worker: number | null }
export function listeningPids(netstat: string, port: number): number[]
export function parseResult(log: string): { passed: number; total: number; failed: number } | null
export function suiteVerdict(run: { code: number; timedOut?: boolean; result: { passed: number; total: number; failed: number } | null }): { ok: boolean; why: string }
export function failures(log: string, max?: number): string[]
export function newSessionLines(log: Uint8Array, before: number, markers?: string[]): string[]
export function countSessionLines(log: Uint8Array, markers?: string[]): number
