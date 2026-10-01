export interface Ports { standIn: number; worker: number }
export interface Identity { name: string; worktree: string; threadId?: string | null }
export interface Lane extends Identity { ports: Ports; rounds: unknown[]; cleanedAt?: string }
export interface Ledger { version: number; lanes: Lane[] }
export interface LaneProcess { pid: number; parentPid: number; name: string; commandLine: string }
export const STAND_INS: number[]
export const WORKERS: number[]
export const RESERVED: number[]
export function portFree(port: number): Promise<boolean>
export function allocatePorts(request: string, lanes: Lane[], free?: (port: number) => Promise<boolean>): Promise<Ports>
export function readLedger(file: string): Ledger
export function writeLedger(file: string, ledger: Ledger): void
export function withLedger<T>(file: string, action: (ledger: Ledger) => T | Promise<T>): Promise<T>
export function pidAlive(pid: number): boolean
export function sleep(ms: number): Promise<void>
export function parseEvents(text: string): { count: number; threadId: string | null; failed: string | null; message: string }
export function laneState(input: { final?: boolean; failed?: string | null; stopped?: string | boolean; alive: boolean; lastEventAt?: number | null; startedAt: number; now?: number; stallMinutes?: number }): string
export function matchesLane(process: LaneProcess, lane: Identity, others?: Identity[]): boolean
export function stopTrees(processes: LaneProcess[], lane: Identity, others: Identity[]): { root: LaneProcess; tree: LaneProcess[] }[]
export function guardCleanup(base: string, target: string): string
export function removeLaneTree(base: string, target: string): void
export function codexArgs(lane: Identity & { model: string; effort: string; search?: boolean }, round: { final: string }, roots: string[], env: Record<string, string>, resume?: boolean): string[]
