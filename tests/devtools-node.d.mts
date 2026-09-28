/** See devtools-node.mjs. */
export const root: string
export function readText(rel: string): string
export function readBytes(rel: string): Uint8Array
export function bytes(s: string): Uint8Array
export function makeBrowserStore(revisions: string[]): { store: string; exe(rev: string): string; cleanup(): void }
export function hookShells(): [string, string[]][]
export function runHook(shell: string, flags: string[], command: string, input: object): { status: number | null; decision: string }
