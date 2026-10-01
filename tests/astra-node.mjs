/** Node-only fixture operations, kept separate from the browser TypeScript configuration. */
export { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, symlinkSync, realpathSync } from 'node:fs'
import { tempScope } from '../scripts/lib/temp.mjs'
let temps = tempScope()
export const mkdtempSync = prefix => temps.makeSync(prefix)
export async function cleanupFixtures() { try { await temps.cleanup() } finally { temps = tempScope() } }
export { join } from 'node:path'
export { tmpdir } from 'node:os'
export const env = process.env
export const bytes = (value, encoding) => Buffer.from(value, encoding)
export const centralOffset = (value) => value.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
export { movePreserving as moveFixtureFile } from '../scripts/astra/layout.mjs'
