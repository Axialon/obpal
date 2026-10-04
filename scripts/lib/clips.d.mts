/** See clips.mjs. */
export interface Segment { key: string; file: string; name: string; path: string; phone: boolean; guest?: boolean }
export interface Options { out: string; origin: string; only: string[]; seconds: number; software: boolean; noLease: boolean; waitMin: number | null; help: boolean }
export interface ClipRow { segment: string; file: string; status: 'pass' | 'WARN' | 'FAIL'; ms: number | null; bytes: number; detail: string }
export const CLIP_SECONDS: { min: number; default: number; max: number }
export const SEGMENTS: Segment[]
export const DEFAULT_OUT: string
export function parseArgs(argv: string[], env?: Record<string, string | undefined>): Options
export function webmDuration(bytes: Uint8Array): number | null
export function clock(ms: number | null | undefined): string
export function inRange(ms: number | null): boolean
export function clipRow(clip: { segment: string; file: string; ms: number | null; bytes: number; detail?: string; companion?: boolean }): ClipRow
export function verdict(rows: { segment: string; file: string; status: string }[]): { ok: boolean; failed: number; warned: number; line: string }
