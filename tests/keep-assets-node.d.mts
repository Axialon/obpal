/** See keep-assets-node.mjs. */
export const joinPath: (...parts: string[]) => string
export function tempDir(): string
export function removeTemp(): void
export function writeSite(root: string, files: Record<string, string>): string
export function readAsset(site: string, name: string): string
export function writeRedirect(root: string): void
