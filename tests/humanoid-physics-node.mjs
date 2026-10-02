/** Node-only measurement output, kept separate from the browser TypeScript configuration. */
export { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
export { tmpdir } from 'node:os'
export { join } from 'node:path'
import { writeSync } from 'node:fs'
/** Passing Vitest tests capture console output; write the measured JSON to the acceptance log directly. */
export function emitMeasurement(report) { writeSync(1, JSON.stringify(report) + '\n') }
