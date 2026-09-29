/** See devtools-node.mjs. */
export const root: string
export function readText(rel: string): string
export function readBytes(rel: string): Uint8Array
export function bytes(s: string): Uint8Array
export function makeTarball(files: Record<string, string | Uint8Array>, opts?: { folder?: string; pax?: boolean; links?: string[] }): Uint8Array
export const nodePath: string
export function runScript(rel: string, args: string[]): { status: number | null; out: string }
export function makeBrowserStore(revisions: string[]): { store: string; exe(rev: string): string; cleanup(): void }
export function hookShells(): [string, string[]][]
export function runHook(shell: string, flags: string[], command: string, input: object): { status: number | null; decision: string }
