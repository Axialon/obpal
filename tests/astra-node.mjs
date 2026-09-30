/** Node-only fixture operations, kept separate from the browser TypeScript configuration. */
export { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, symlinkSync, realpathSync } from 'node:fs'
export { join } from 'node:path'
export { tmpdir } from 'node:os'
export const env = process.env
export const bytes = (value, encoding) => Buffer.from(value, encoding)
export const centralOffset = (value) => value.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
