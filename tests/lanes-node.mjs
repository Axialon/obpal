/** Filesystem access for synthetic tooling fixtures; all writes stay in temporary folders. */
export { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
export { tmpdir } from 'node:os'
export { join } from 'node:path'
