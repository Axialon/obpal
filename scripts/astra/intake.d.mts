import type { Bytes } from './zip.mjs'
import type { Manifest } from './common.mjs'
export const STAGE_LIMITS: { payload: number; before: number; literals: number; touched: number }
export interface Stage {
  bytes: Bytes; members: Record<string, Bytes>; manifest: Manifest; touched: string[];
  patches: string[]; files: string[]; suites: string[]; base: string
}
export function namedSuites(text: string): string[]
export function verifyStage(options: { root: string; returned: string; request: string }): Stage
export function applyStage(root: string, stage: Stage): string
export type Runner = (root: string, argv: string[], env: Record<string, string | undefined>) => { exit_code: number; log: string } | Promise<{ exit_code: number; log: string }>
export interface Report {
  path: string; result: string; steps: { step: string; status: string; exit_code?: number; reason?: string }[];
  head: string | null; branch: string | null; deviations: string[]
}
export function intake(options: { root: string; returned: string; request?: string; outbox?: string; run?: Runner }): Promise<Report>
export function verification(options: { root: string; stage: string; outbox?: string; port?: string; workerPort?: string; run?: Runner }): Promise<Report>
