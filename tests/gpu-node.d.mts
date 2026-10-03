export function mkdtemp(prefix: string): Promise<string>
export function readFile(path: string, encoding: 'utf8'): Promise<string>
export function readFile(path: string): Promise<unknown>
export function rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>
export function mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>
export function writeFile(path: string, data: string): Promise<void>
export function tmpdir(): string
export function join(...parts: string[]): string
export const pid: number
export function childGpuPath(file: string, temp: string): Promise<string>
export function startGpuChild(file: string, temp: string, mode?: 'shared' | 'exclusive'): { acquired: Promise<number>; finish(): Promise<{ code: number | null; stderr: string }>; stop(): Promise<void> }
