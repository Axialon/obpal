/** See browser.mjs. */
export function resolveChromium(env?: Record<string, string | undefined>): Promise<{ path: string; from: string }>
export function newestInstalled(wanted: string): string
export function shortPath(p: string): string

export function e2eBrowserOptions<T extends { args?: string[] }>(options: T, env?: Record<string, string | undefined>, platform?: string): T
export function detectE2eGpu(executablePath: string, options?: { platform?: string; launch?: (options: unknown) => Promise<{ newPage(): Promise<{ evaluate(fn: () => string): Promise<string> }>; close(): Promise<void> }> }): Promise<{ hardware: boolean; renderer: string; reason: string }>
