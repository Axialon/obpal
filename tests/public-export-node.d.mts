export function liveWithoutTarget(): { status: number | null; output: string }
export function publicationFixture(mode: string): {
  status: number | null; output: string; baseline: string; source: string; tree: string; head: string; publicTree: string; parent: string; identity: string[]
  calls: { command: string; args: string[] }[]
}
export function materializationFixture(mode: string): {
  error: string | null; paths?: string[]; stagedPaths?: string[]; manifest?: import('../scripts/lib/public-export.mjs').PublicOutputManifest;
  catalog?: string; config?: Record<string, any>; publicPolicy?: import('../scripts/lib/public-export.mjs').PublicExportPolicy; reproduced?: boolean
  stagedGitMode?: string; reexportMode?: string; toolingMode?: string
}
export function readPublicSource(path: string): string
export function inspectFilmAssets(text: string, manifestText: string): Promise<{ inventory: unknown[]; requests: number; answers: unknown[] }>
export function inspectCatalog(text: string): Promise<{
  ids: string[]; categories: string[]; defaultId: string; art: Record<string, { color: string; image?: string; icon?: string }>;
  diagnostics: string[]; made: string[]
}>
export function exportFixture(files: Record<string, string>): {
  status: number | null; output: string; config: Record<string, any> | null; files: string[]; readme: string
}
