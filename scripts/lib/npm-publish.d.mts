/** See npm-publish.mjs. */
export interface Version { major: number; minor: number; patch: number; pre: string }
export function parseVersion(v: string): Version | null
export function compareVersions(a: string, b: string): number
export function highestRelease(versions: string[]): string | null
export function satisfies(version: string, range: string): boolean | null

export type Packed = Map<string, Uint8Array>
export function readTarball(data: Uint8Array): Packed
export function isTextFile(path: string): boolean
export interface Comparison { same: boolean; added: string[]; removed: string[]; changed: string[] }
export function comparePacked(a: Packed, b: Packed, opts?: { ignoreManifest?: string[] }): Comparison
export function describeChange(c: Comparison): string
export function integrityOf(bytes: Uint8Array): string

export interface TarballFinding { path: string; what: string; line?: number; hint?: string }
export function scanTarball(files: Packed, expect: { name: string; version: string; deny?: string[] }): TarballFinding[]

export interface PlannedPackage { name: string; version: string; dependencies?: Record<string, string> }
export interface RegistryState { versions: string[]; same?: boolean | null }
export interface Step { name: string; version: string; latest: string | null; action: 'publish' | 'skip' | 'refuse'; why: string }
export interface Link { name: string; dep: string; range: string; resolves: string; ok: boolean }
export function planRelease(packages: PlannedPackage[], registry: Record<string, RegistryState>): { steps: Step[]; links: Link[]; problems: string[] }

export function authUrls(text: string): string[]
export function authWatcher(): { feed(chunk: string): string[]; end(): string[] }
export function streamCommand(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; shell?: boolean; keepStdinOpen?: boolean; timeoutMs?: number; write?: (stream: 'stdout' | 'stderr', text: string) => void; onApprove?: (url: string) => void },
): Promise<{ ok: boolean; code: number | null; ms: number; timedOut: boolean; tail: string }>
export function waitUntil<T>(
  check: () => Promise<T | false | null | undefined>,
  opts: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number; onWait?: (ms: number) => void },
): Promise<{ ok: boolean; value: T | null; tries: number; ms: number }>
export function packageTests(sources: Record<string, string>): string[]
