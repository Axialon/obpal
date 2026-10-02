export interface Ports { standIn: number; worker: number }
export interface Identity { name: string; worktree: string; threadId?: string | null }
export interface Lane extends Identity { ports: Ports; rounds: unknown[]; cleanedAt?: string; cleaningAt?: string; branch?: string; evidenceArchive?: string | null }
export interface Ledger { version: number; lanes: Lane[] }
export interface LaneProcess { pid: number; parentPid: number; name: string; commandLine: string }
export const STAND_INS: number[]
export const WORKERS: number[]
export const RESERVED: number[]
export function portFree(port: number): Promise<boolean>
export function allocatePorts(request: string, lanes: Lane[], free?: (port: number) => Promise<boolean>): Promise<Ports>
export function readLedger(file: string): Ledger
export function writeLedger(file: string, ledger: Ledger): void
export function withLedger<T>(file: string, action: (ledger: Ledger) => T | Promise<T>, options?: { open?: (path: string, flags: string) => number }): Promise<T>
export function pidAlive(pid: number): boolean
export function sleep(ms: number): Promise<void>
export function parseEvents(text: string): { count: number; threadId: string | null; failed: string | null; message: string }
export function laneState(input: { final?: boolean; failed?: string | null; stopped?: string | boolean; alive: boolean; lastEventAt?: number | null; startedAt: number; now?: number; stallMinutes?: number }): string
export function matchesLane(process: LaneProcess, lane: Identity, others?: Identity[]): boolean
export function stopTrees(processes: LaneProcess[], lane: Identity, others: Identity[]): { root: LaneProcess; tree: LaneProcess[] }[]
export function guardCleanup(base: string, target: string): string
export function removeLaneTree(base: string, target: string, options?: { discardArtifacts?: boolean }): void
export function codexArgs(lane: Identity & { model: string; effort: string; search?: boolean }, round: { final: string }, roots: string[], env: Record<string, string>, resume?: boolean): string[]

export function cleanupLane(file: string, name: string, options: { prepare: (lane: Lane, ledger: Ledger) => void | Promise<void>; archive: (lane: Lane) => string | null | Promise<string | null>; remove: (lane: Lane, archive: string | null) => void | Promise<void>; finish?: (lane: Lane) => void | Promise<void>; alive?: (lane: Lane, ledger: Ledger) => boolean }): Promise<void>

export function waitLane<T extends { state: string; alive: boolean }>(status: () => T | Promise<T>, minutes: number, options?: { pause?: (ms: number) => Promise<void>; now?: () => number }): Promise<T>
export function stopFinalLane(lane: Lane, others: Lane[], options: { inventory: () => LaneProcess[]; status: (inventory: LaneProcess[]) => { state: string; alive: boolean }; kill: (tree: { root: LaneProcess; tree: LaneProcess[] }) => void | Promise<void>; log?: (text: string) => void; pause?: (ms: number) => Promise<void>; now?: () => number }): Promise<void>
