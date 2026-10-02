export function acquireGpuLease(options?: { file?: string; timeoutMs?: number; pollMs?: number; signal?: AbortSignal; waiting?: () => void }): Promise<() => Promise<void>>
