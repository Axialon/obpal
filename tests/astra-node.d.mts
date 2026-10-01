import type { Bytes } from '../scripts/astra/zip.mjs'
export function mkdtempSync(prefix: string): string
export function cleanupFixtures(): Promise<void>
export function moveFixtureFile(source: string, destination: string): string
export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined
export function readFileSync(path: string): Bytes
export function readFileSync(path: string, encoding: string): string
export function writeFileSync(path: string, value: string | Uint8Array): void
export function existsSync(path: string): boolean
export function unlinkSync(path: string): void
export function symlinkSync(target: string, path: string, type: 'junction'): void
export function realpathSync(path: string): string
export function join(...parts: string[]): string
export function tmpdir(): string
export const env: Record<string, string | undefined>
export function bytes(value: string | Uint8Array, encoding?: string): Bytes
export function centralOffset(value: Bytes): number
