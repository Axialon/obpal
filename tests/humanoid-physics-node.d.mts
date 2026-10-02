export function mkdtempSync(prefix: string): string
export function writeFileSync(path: string, value: string): void
export function readFileSync(path: string, encoding: string): string
export function tmpdir(): string
export function join(...parts: string[]): string
export function emitMeasurement(report: unknown): void
