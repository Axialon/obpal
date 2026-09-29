/** See keep-assets.mjs. */
export const KEEP_BUILDS: number
export const STORE: string
export function deployedSite(root: string): string
export function listFiles(dir: string): string[]
export function keptBuilds(store: string): string[]
export function carryKept(o: { site: string; store: string; keep?: number }): { fresh: string[]; carried: string[]; from: string[] }
export function keepBuild(o: { site: string; store: string; fresh: string[]; keep?: number }): string | null
