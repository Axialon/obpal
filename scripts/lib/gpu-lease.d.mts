export type GpuOwner = { pid: number; processStartedAt?: string; token: string; startedAt: string; mode: 'shared' | 'exclusive'; suite: string; lane: string; order?: number; reason?: string; file?: string }
export const GPU_LEASE_FILE: string
export function gpuProcessStart(pid: number): Promise<string | null | undefined>
export function acquireGpuLease(options?: { file?: string; mode?: 'shared' | 'exclusive'; slots?: number | string; timeoutMs?: number; pollMs?: number; signal?: AbortSignal; waiting?: (owner: { mode: string; suite: string }) => void; reclaimed?: (owner: GpuOwner) => void; suite?: string; lane?: string; processStart?: (pid: number) => Promise<string | null | undefined> }): Promise<(() => Promise<void>) | null>
export function gpuStatus(options?: { file?: string }): Promise<{ slots: number; holders: GpuOwner[]; queue: GpuOwner[]; coordinator: GpuOwner | null }>
