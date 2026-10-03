export type GpuMode = 'shared' | 'exclusive'
export const FULL_SIMS_GROUPS: string[]
export const EXCLUSIVE_SIMS_GROUPS: string[]
export function gpuModeForSuite(suite: string, env?: Record<string, string | undefined>): GpuMode
export function gpuRuns(suite: string, env?: Record<string, string | undefined>): { suite: string; label: string; mode: GpuMode; env: Record<string, string> }[]
