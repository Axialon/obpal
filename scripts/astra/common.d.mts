import type { Bytes } from './zip.mjs'
export const REPOSITORY: string
export const SUITES: string[]
export function sha256(bytes: string | Uint8Array): string
export function json(value: unknown): string
export function git(root: string, args: string[], input?: string | Uint8Array): Bytes
export function archive(members: Record<string, string | Uint8Array>, metadata: Record<string, unknown>): Bytes
export interface Manifest {
  schema_version: number; repository: string; kind: string; stage: string; master_sha: string
  files: Record<string, string>; source_hashes: Record<string, string>
  source_modes?: Record<string, string>
  export_scope: { globs: string[]; paths: string[]; trimmed: { path: string; reason: string }[] }
  input: { sha: string; archive_sha256: string; hashes: Record<string, string> }
  changed_paths: string[]; new_paths: string[]; deleted_paths: string[]
}
export function loadArchive(path: string): { bytes: Bytes; members: Record<string, Bytes>; manifest: Manifest }
export function guarded(path: string): string
