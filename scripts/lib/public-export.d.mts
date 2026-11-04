export function selfHostWrangler(text: string): string
export function isIndexNowProof(path: string): boolean
export function exportProblems(path: string, bytes: Uint8Array, opts?: { deny?: string[]; vendored?: boolean }): string[]

export type PublicRole = 'code' | 'asset' | 'notice' | 'policy' | 'documentation'
export interface PublicInputRow {
  path: string
  role: PublicRole
  source: 'payload' | 'tooling'
  rights: string
  noticePaths: string[]
  inputSha256?: string
  provenance?: { kind: 'original' | 'vendor' | 'brand'; reference: string }
  transform?: 'wrangler' | 'catalog' | 'arena' | 'campaign' | 'film-manifest' | 'film-assets' | 'policy'
}
export interface PublicExclusion { path: string; reason: string; inputSha256?: string }
export interface PublicExportPolicy {
  schema: 1
  profile: 'public-demo-v1'
  payloadRevision: string | null
  include: PublicInputRow[]
  exclude: PublicExclusion[]
  blockedSha256: string[]
  catalog: { items: string[]; categories: string[]; defaultId: string }
}
export interface PublicExportPlan {
  payloadRevision: string | null
  catalog: PublicExportPolicy['catalog']
  inputs: PublicInputRow[]
  copyPaths: string[]
  transforms: { path: string; kind: NonNullable<PublicInputRow['transform']> }[]
  omissions: PublicExclusion[]
  inputModes?: Record<string, '100644' | '100755'>
}
export interface PublicOutputRow {
  path: string
  sourcePath?: string
  sourceSha256?: string
  sha256: string
  bytes: number
  mode: '100644' | '100755'
  role: PublicRole
  noticePaths: string[]
}
export interface PublicOutputManifest {
  schema: 1
  profile: 'public-demo-v1'
  policySha256: string
  rows: PublicOutputRow[]
}
export function selectPublicFiles(trackedPaths: readonly string[], policy: PublicExportPolicy): PublicExportPlan
export function verifyPublicOutput(plan: PublicExportPlan, manifest: PublicOutputManifest, actualPaths: readonly string[]): string[]
export interface PublicMaterialization {
  plan: PublicExportPlan
  manifest: PublicOutputManifest
  files: string[]
  manifestSha256: string
  source: { revision: string; indexSha256: string; raw: { path: string; sha256: string }[] }
  assertSourceUnchanged(): void
}
export function materializePublicExport(options: { root: string; out: string; deny?: string[] }): PublicMaterialization
export function verifyPublicDirectory(options: {
  out: string; plan: PublicExportPlan; manifest: PublicOutputManifest; root?: string; deny?: string[]; allowGit?: boolean
}): { files: string[]; manifestSha256: string }
export function publicClosureProblems(options: { out: string; manifest: PublicOutputManifest }): string[]
export function stagePublicOutput(options: {
  out: string; destination: string; plan: PublicExportPlan; manifest: PublicOutputManifest; root?: string; deny?: string[];
  assertSourceUnchanged?: () => void
}): { files: string[]; manifestSha256: string }
export function stagePublicGitModes(options: { destination: string; manifest: PublicOutputManifest }): { executables: string[]; indexSha256: string }
