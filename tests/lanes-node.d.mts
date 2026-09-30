export function mkdtempSync(prefix: string): string
export function mkdirSync(path: string, options?: { recursive?: boolean }): void
export function writeFileSync(path: string, text: string): void
export function readFileSync(path: string, encoding: 'utf8'): string
export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void
export function symlinkSync(target: string, path: string, type: 'junction'): void
export function existsSync(path: string): boolean
export function tmpdir(): string
export function join(...paths: string[]): string
