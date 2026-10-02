export function mkdtemp(prefix: string): Promise<string>
export function readFile(path: string, encoding: 'utf8'): Promise<string>
export function readFile(path: string): Promise<unknown>
export function rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>
export function tmpdir(): string
export function join(...parts: string[]): string
export const pid: number
