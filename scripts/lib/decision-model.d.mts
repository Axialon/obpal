export const MODEL: string
export const DIGEST_LIMIT: number
export const digestSchema: Record<string, any>
export const triageSchema: Record<string, any>
export interface ModelResult { output: string; usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | null; model?: string; failed?: string | null }
export interface ModelRequest { prompt: string; schema: Record<string, any>; model: string; timeoutMs: number; images?: string[] }
export interface DecisionOptions { runner?: (request: ModelRequest) => Promise<ModelResult>; timeoutMs?: number; guidance?: string; provider?: 'model' | 'vision'; images?: string[] }
export function validSchema(value: unknown, schema: Record<string, any>): boolean
export function safePath(file: string, root: string): string
export function readInput(file: string, root: string, limit?: number, tail?: boolean): { text: string; bytes: number; truncated: boolean }
export function sanitize(text: string): string
export function cleanLog(text: string): string
export function modelResponse(result: { events: string; output: string; code: number | null; timedOut?: boolean; overflow?: boolean; model?: string }): ModelResult
export function runVision(request: ModelRequest & { executable?: string; execute?: (...args: any[]) => any }): Promise<ModelResult>
export function runModel(request: ModelRequest): Promise<ModelResult>
export function classify<T>(baseline: T, source: unknown, schema: Record<string, any>, options?: DecisionOptions, accept?: (candidate: T) => boolean): Promise<T & { model: string; tokens: { in: number | null; cached: number | null; out: number | null } | null; mode: string; note?: string }>
export function codexExecutable(): string
export function logFiles(directory: string): string[]
