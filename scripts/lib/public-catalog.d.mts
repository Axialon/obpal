import type { PublicExportPolicy } from './public-export.mjs'
export function projectPublicCatalog(sourceText: string, policy: PublicExportPolicy): string
export function projectPublicArena(sourceText: string): string
export function projectPublicCampaign(sourceText: string): string
export function projectPublicFilmManifest(sourceText: string): string
export function projectPublicFilmAssets(sourceText: string, manifestText: string): string
