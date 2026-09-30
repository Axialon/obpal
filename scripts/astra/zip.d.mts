export interface Bytes extends Uint8Array {
  toString(encoding?: string): string
  writeUInt32LE(value: number, offset: number): number
  subarray(begin?: number, end?: number): Bytes
}
export const LIMITS: { archive: number; total: number; member: number; count: number }
export function safePath(path: string): string
export function writeZip(members: Record<string, string | Uint8Array>): Bytes
export function readZip(bytes: Uint8Array): Record<string, Bytes>
