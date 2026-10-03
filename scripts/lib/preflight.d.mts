/** See preflight.mjs. */
export interface Row { part: string; check: string; status: 'pass' | 'FAIL' | 'WARN' | 'skip'; ms: number; detail: string }
export interface Options { origin: string; sims: string[]; only: string[]; out: string; budgetS: number; withoutBeacon: boolean; help: boolean }
export interface SimTarget { key: string; name: string; path: string }
export interface FrameLook { colours: number; mean: number; spread: number }
export const DEFAULT_ORIGIN: string
export const PARTS: string[]
export const SIMS: Record<string, { name: string; path: string }>
export const DEFAULT_SIMS: string[]
export const DEFAULT_BUDGET_S: number
export function parseArgs(argv: string[], env?: Record<string, string | undefined>): Options
export function simTarget(nameOrPath: string): SimTarget
export function frameLook(rgb: Uint8Array): FrameLook
export function drawn(look: FrameLook): boolean
export function beaconInjected(html: string): boolean
export function stripBeacon(html: string): string
export function isZip(bytes: Uint8Array): boolean
export function desktopZipHref(html: string): string | null
export function brief(error: unknown, max?: number): string
export function seconds(ms: number): string
export function verdict(rows: { part: string; check: string; status: string }[]): { ready: boolean; failed: number; warned: number; skipped: number; line: string }
export function guardLine(before: Uint8Array | null, after: Uint8Array | null, markers?: string[]): { reached: string[]; line: string }
