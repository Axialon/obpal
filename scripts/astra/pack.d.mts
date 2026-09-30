import type { Bytes } from './zip.mjs'
export function buildPack(options: { root: string; stage: string; task: string; globs?: string[]; budget?: number;
  checkpoint?: { master_sha?: string; check_summary?: string; e2e_summary?: string } }): {
  bytes: Bytes; prompt: string; trimmed: { path: string; reason: string; bytes?: number }[]; master: string; files: number
}
